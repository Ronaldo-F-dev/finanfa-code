import type { ToolContext, ToolDefinition, LlmProvider, FilePreview } from "../core/types.js";
import type { UIAdapter } from "../ui/adapter.js";
import type { PermissionConfig, PermissionDecision } from "./config.js";
import type { HooksConfig } from "../hooks/config.js";
import { loadManagedSettings } from "../core/managed-settings.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { runHooks, type HookLlmRunner, type HookOutcome, type HookPayload } from "../hooks/runner.js";
import type { HookEventName } from "../hooks/config.js";
import { appendAuditEvent, type AuditDecisionSource } from "../observability/audit-log.js";
import { APPROVAL_CATEGORIES, approvalCategoryOf, type ApprovalCategory, type AutoApproveSettings } from "./categories.js";
import { classifyToolRisk, resolveClassifierModel, type AutoApprovalClassifierConfig } from "./classifier.js";

export type AskAnswer = "allow" | "deny" | "always" | "always-tool";

export interface PermissionManagerOptions {
  config: PermissionConfig;
  ui: UIAdapter;
  /** If true, never prompt: auto-deny anything not pre-allowed by config (fail safe). */
  nonInteractive?: boolean;
  /** If true, auto-approve everything without prompting (opt-in, scripted use). */
  yolo?: boolean;
  /** PreToolUse hooks, if any are configured. Deliberately checked BEFORE yolo/config/prompting — a hook is a guardrail the user or org opted into, meant to hold even under --yolo. */
  hooksConfig?: HooksConfig;
  /** Needed only for the auto-approval classifier (see classifier.ts) — the same provider the session already talks to, just given a different (cheap/fast) model for the classification call itself. Unset means the classifier can never run, even if config.autoApprovalClassifier.enabled is true. */
  provider?: LlmProvider;
}

export class PermissionManager {
  private readonly config: PermissionConfig;
  private readonly ui: UIAdapter;
  private readonly nonInteractive: boolean;
  private readonly yolo: boolean;
  private hooksConfig?: HooksConfig;
  private provider?: LlmProvider;
  /** Categories approved without asking (see categories.ts). Empty when managed settings forbid skipping prompts. */
  private autoApprove: AutoApproveSettings;
  private readonly autoApproveForbidden: boolean;
  /** Set once the task tool exists (see registerStatefulBuiltins) — what a "agent" hook runs its read-only sub-agent with. */
  private hookAgentRunner?: (prompt: string, timeoutMs: number) => Promise<string>;
  /** True inside the run of a prompt/agent hook, so hooks never fire from within a hook's own model/agent calls (a PreToolUse agent hook whose agent calls a tool would otherwise recurse forever). Scoped per async call chain, so unrelated concurrent tool calls are unaffected. */
  private readonly insideLlmHook = new AsyncLocalStorage<boolean>();
  private readonly sessionAllowlist = new Set<string>();
  /**
   * Runtime override for config.autoApprovalClassifier (see /permissions in
   * builtin.ts). `hasClassifierOverride` distinguishes "never touched at
   * runtime, defer to config" from "explicitly turned off this session" —
   * without it, setAutoApprovalClassifier(undefined) (turning the mode OFF)
   * would be indistinguishable from never having called it, and `??` would
   * silently fall back to a config that still says enabled: true.
   */
  private classifierOverride?: AutoApprovalClassifierConfig;
  private hasClassifierOverride = false;

  constructor(opts: PermissionManagerOptions) {
    this.config = opts.config;
    this.ui = opts.ui;
    this.nonInteractive = opts.nonInteractive ?? false;
    // An administrator's disableYolo wins over the --yolo flag, which can only ever relax prompts.
    const yoloForbidden = loadManagedSettings().disableYolo === true;
    this.yolo = (opts.yolo ?? false) && !yoloForbidden;
    if (opts.yolo && yoloForbidden) opts.ui.writeError("--yolo is disabled by this machine's managed settings, tool calls will still ask for approval.");
    this.hooksConfig = opts.hooksConfig;
    this.provider = opts.provider;
    // disableYolo in the managed settings is the administrator's "nothing may skip the prompts" switch: it covers
    // per-category auto-approval as well as --yolo.
    this.autoApproveForbidden = yoloForbidden;
    this.autoApprove = yoloForbidden ? {} : { ...opts.config.autoApprove };
  }

  /** The categories currently approved without asking. */
  getAutoApprove(): AutoApproveSettings {
    return { ...this.autoApprove };
  }

  /** True when an administrator's managed settings forbid skipping prompts, so no category can be switched on. */
  isAutoApproveForbidden(): boolean {
    return this.autoApproveForbidden;
  }

  /** Switches a category on or off for this session. Refused (returns false) under the managed-settings policy. */
  setAutoApprove(category: ApprovalCategory, enabled: boolean): boolean {
    if (this.autoApproveForbidden || !APPROVAL_CATEGORIES.includes(category)) return false;
    this.autoApprove = { ...this.autoApprove, [category]: enabled };
    return true;
  }

  /** Turns the auto-approval classifier mode on/off (or changes its model) at runtime — see /permissions. Passing undefined explicitly turns it off for this session, regardless of what config says. */
  setAutoApprovalClassifier(config: AutoApprovalClassifierConfig | undefined): void {
    this.classifierOverride = config;
    this.hasClassifierOverride = true;
  }

  /** Keeps the classifier's provider in sync when a caller switches its own active provider mid-session (e.g. web-server's set_model/set_effort) — without this, the classifier would keep classifying against whatever provider was active at construction time. */
  setProvider(provider: LlmProvider | undefined): void {
    this.provider = provider;
  }

  getAutoApprovalClassifier(): AutoApprovalClassifierConfig | undefined {
    return this.hasClassifierOverride ? this.classifierOverride : this.config.autoApprovalClassifier;
  }

  /**
   * A tool's own `riskKey` is arbitrary caller-supplied code — not guaranteed
   * not to throw on a malformed `input` (e.g. bash's used to do
   * `input.command.trim()`, which crashed raw when a provider's tool-call
   * arguments failed to parse and the caller fell back to `input = {}`).
   * Caught here for the same reason describeCall()/preview() are caught
   * below: this runs before that guarded block, on every check() call, not
   * just the "ask" path.
   */
  private riskKey(tool: ToolDefinition, input: unknown): string {
    if (!tool.riskKey) return tool.name;
    try {
      return tool.riskKey(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ui.writeError(`Could not compute a risk key for "${tool.name}": ${message}`);
      return tool.name;
    }
  }

  private matchRule(tool: ToolDefinition, key: string, cwd: string): PermissionDecision | undefined {
    for (const rule of this.config.rules) {
      if (rule.tool !== "*" && rule.tool !== tool.name) continue;
      if (rule.keyPrefix && !key.startsWith(rule.keyPrefix)) continue;
      if (rule.cwdPrefix && !cwd.startsWith(rule.cwdPrefix)) continue;
      return rule.decision;
    }
    return undefined;
  }

  /**
   * Runs any configured PostToolUse hooks for informational purposes only —
   * the tool has already completed by this point, so unlike PreToolUse a
   * "block" decision here can't undo anything real; only its stdout (or a
   * block's reason) is ever surfaced to the user. Never throws: a broken
   * hook must not turn a successful tool call into a failed turn.
   */
  async runPostToolUseHook(tool: ToolDefinition, input: unknown, toolResponse: unknown, ctx: ToolContext): Promise<void> {
    if (!this.hooksConfig) return;
    const outcome = await this.runHooksGuarded(
      "PostToolUse",
      { hook_event_name: "PostToolUse", session_id: ctx.sessionId, cwd: ctx.cwd, tool_name: tool.name, tool_input: input, tool_response: toolResponse },
      ctx.cwd,
    );
    const message = outcome.decision === "block" ? (outcome.reason ?? "(blocked by a PostToolUse hook)") : outcome.output;
    if (message) this.ui.writeSystem(message);
  }

  /**
   * Runs any configured UserPromptSubmit hooks before a user's message is
   * sent to the model. "block" prevents the prompt from being sent at all
   * (its reason is shown to the user instead); otherwise a hook's plain
   * stdout is appended to the prompt as extra context the model sees
   * alongside it (real Claude Code's own use for this hook: injecting
   * project-specific context, a reminder, current git state, etc.).
   */
  async runUserPromptSubmitHook(prompt: string, cwd: string, sessionId: string): Promise<{ blockedReason?: string; prompt: string }> {
    if (!this.hooksConfig) return { prompt };
    const outcome = await this.runHooksGuarded("UserPromptSubmit", { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd, prompt }, cwd);
    if (outcome.decision === "block") return { blockedReason: outcome.reason ?? "Blocked by a UserPromptSubmit hook.", prompt };
    if (outcome.output) return { prompt: `${prompt}\n\n<user-prompt-submit-hook-context>\n${outcome.output}\n</user-prompt-submit-hook-context>` };
    return { prompt };
  }

  /** Lets the entry point say how an "agent" hook runs its sub-agent (the task tool's machinery). */
  setHookAgentRunner(runner: (prompt: string, timeoutMs: number) => Promise<string>): void {
    this.hookAgentRunner = runner;
  }

  /** What "prompt" and "agent" hooks call to reach a model: one cheap-model call, and the sub-agent runner. Every call is marked so hooks can't re-enter from inside it. */
  private llmRunner(): HookLlmRunner {
    const provider = this.provider;
    const agentRunner = this.hookAgentRunner;
    return {
      prompt: provider
        ? (prompt, model, timeoutMs) =>
            this.insideLlmHook.run(true, async () => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), timeoutMs);
              try {
                const result = await provider.streamTurn({
                  model: model ?? resolveClassifierModel(this.getAutoApprovalClassifier()),
                  systemPrompt: "You are a strict, precise reviewer for an autonomous coding agent. Follow the instructions and output only the requested JSON.",
                  messages: [{ role: "user", content: prompt }],
                  tools: [],
                  onTextDelta: () => {},
                  signal: controller.signal,
                  maxTokens: 400,
                });
                return result.assistantMessage.content;
              } finally {
                clearTimeout(timer);
              }
            })
        : undefined,
      agent: agentRunner ? (prompt, timeoutMs) => this.insideLlmHook.run(true, () => agentRunner(prompt, timeoutMs)) : undefined,
    };
  }

  /** Every hook run goes through here: nothing fires from inside a prompt/agent hook's own run, and those hooks get a model to talk to. */
  private async runHooksGuarded(event: HookEventName, payload: HookPayload, cwd: string): Promise<HookOutcome> {
    if (!this.hooksConfig || this.insideLlmHook.getStore()) return {};
    return runHooks(this.hooksConfig, event, payload, cwd, this.llmRunner());
  }

  /** Replaces the hooks config mid-session (see /plugin reload) — takes effect from the next hook call. */
  setHooksConfig(config: HooksConfig): void {
    this.hooksConfig = config;
  }

  /** The hooks config currently in effect (read-only view, for /hooks). */
  getHooksConfig(): HooksConfig {
    return this.hooksConfig ?? {};
  }

  /**
   * Runs the hooks for a lifecycle event that isn't tied to a tool call
   * (Stop, SubagentStop, SessionStart, SessionEnd, Notification,
   * PreCompact). Never throws: a broken hook must not break the session.
   * Callers decide what a "block" means — for Stop it forces the turn to
   * continue with the hook's reason as feedback; for the rest it is only
   * surfaced as a message.
   */
  async runLifecycleHook(event: HookEventName, cwd: string, sessionId: string, extra: Partial<HookPayload> = {}): Promise<HookOutcome> {
    if (!this.hooksConfig?.[event]?.length) return {};
    try {
      return await this.runHooksGuarded(event, { ...extra, hook_event_name: event, session_id: sessionId, cwd }, cwd);
    } catch {
      return {};
    }
  }

  /** Returns a decision when a PreToolUse hook has an opinion (block/approve); undefined means the normal permission flow should decide instead. */
  private async checkPreToolUseHooks(tool: ToolDefinition, input: unknown, ctx: ToolContext): Promise<"allow" | "deny" | undefined> {
    if (!this.hooksConfig) return undefined;
    const outcome = await this.runHooksGuarded(
      "PreToolUse",
      { hook_event_name: "PreToolUse", session_id: ctx.sessionId, cwd: ctx.cwd, tool_name: tool.name, tool_input: input },
      ctx.cwd,
    );
    if (outcome.decision === "block") {
      const reasonSuffix = outcome.reason ? `: ${outcome.reason}` : "";
      this.ui.writeError(`"${tool.name}" blocked by a PreToolUse hook${reasonSuffix}`);
      return "deny";
    }
    if (outcome.decision === "approve") return "allow";
    if (outcome.output) this.ui.writeSystem(outcome.output);
    return undefined;
  }

  /** Appends one line to the audit log (~/.finanfa-code/audit/<date>.jsonl) for every decision this method reaches, regardless of which path decided it — a denied call never even reaches the OTel trace file (see loop.ts), so this is the only durable, structured record of it. */
  private record(tool: ToolDefinition, riskKey: string, ctx: ToolContext, decision: "allow" | "deny", source: AuditDecisionSource): "allow" | "deny" {
    appendAuditEvent({ sessionId: ctx.sessionId, cwd: ctx.cwd, tool: tool.name, riskLevel: tool.riskLevel, riskKey, decision, source });
    return decision;
  }

  /** `toolCallId` is the model's own tool_use id for this call, if the caller has minted one yet (see loop.ts) — passed through to askUser so an adapter like the ACP bridge can correlate its permission request with the real tool_call, not a synthetic placeholder. */
  async check(tool: ToolDefinition, input: unknown, ctx: ToolContext, toolCallId?: string): Promise<PermissionDecision> {
    const riskKey = this.riskKey(tool, input);

    const hookDecision = await this.checkPreToolUseHooks(tool, input, ctx);
    if (hookDecision) return this.record(tool, riskKey, ctx, hookDecision, "pre_tool_use_hook");

    if (this.yolo) return this.record(tool, riskKey, ctx, "allow", "yolo");

    const key = `${tool.name}:${riskKey}`;
    if (this.sessionAllowlist.has(key) || this.sessionAllowlist.has(tool.name)) {
      return this.record(tool, riskKey, ctx, "allow", "session_allowlist");
    }

    const ruleDecision = this.matchRule(tool, riskKey, ctx.cwd);
    // A category the user approved wholesale covers any call of its tools that no explicit rule speaks for: a rule
    // naming this tool (allow, ask or deny) is the more specific statement and always wins over the general one.
    if (ruleDecision === undefined) {
      const category = approvalCategoryOf(tool.name);
      if (category && this.autoApprove[category]) return this.record(tool, riskKey, ctx, "allow", "category_auto_approve");
    }
    const decision = ruleDecision ?? this.config.defaultForRiskLevel[tool.riskLevel];

    if (decision !== "ask") return this.record(tool, riskKey, ctx, decision, ruleDecision ? "rule" : "default_for_risk_level");

    // Only reached for a call the static logic would otherwise send to
    // "ask" — the classifier supplements that path, it never overrides an
    // already-decided allow/deny. Fully opt-in (config.autoApprovalClassifier
    // unset/disabled is the default and leaves this whole block dead code),
    // and fails open to the existing "ask" flow below on any classifier
    // failure (error, timeout, unparseable response) or when no provider
    // was wired in — never fails open to "allow".
    const classifierConfig = this.getAutoApprovalClassifier();
    if (classifierConfig?.enabled && this.provider) {
      const classification = await classifyToolRisk(this.provider, resolveClassifierModel(classifierConfig), tool, input, ctx.signal);
      if (classification?.risk === "low") {
        return this.record(tool, riskKey, ctx, "allow", "auto_approval_classifier");
      }
      if (classification?.risk === "medium") {
        this.ui.writeSystem(
          `Auto-approved "${tool.name}" (medium risk, per-call classifier): ${classification.justification || "(no justification returned)"}`,
        );
        return this.record(tool, riskKey, ctx, "allow", "auto_approval_classifier");
      }
      // classification.risk === "high", or classification is undefined
      // (classifier failed) — both fall through to the normal ask prompt below.
    }

    if (this.nonInteractive) return this.record(tool, riskKey, ctx, "deny", "non_interactive");

    // Neither describeCall() nor preview() is guaranteed not to throw — e.g.
    // edit_file's preview() throws when old_string no longer matches (a
    // common failure: stale content, file changed since last read). Left
    // uncaught, this used to escape check() as an unhandled exception,
    // ending the turn with the tool_use message already in session.messages
    // but never resolved — every later request in the session then fails,
    // since providers reject a tool_use with no matching tool_result.
    // Denying (a decision this function already knows how to turn into a
    // proper tool_result) is the safe fallback, not crashing the turn.
    let summary: string;
    let preview: string | undefined;
    let filePreview: FilePreview | undefined;
    try {
      summary = tool.describeCall ? tool.describeCall(input) : JSON.stringify(input);
      preview = tool.preview ? await tool.preview(input, ctx) : undefined;
      // Deliberately swallowed on its own, separate from the try/catch's
      // existing deny-on-error policy above: filePreview is a pure bonus for
      // a UI that can render a real diff (see askUser's own doc comment) —
      // its own failure (e.g. the same stale-old_string case preview()
      // throws on, but filePreview already returns undefined for) must
      // never turn a normal permission prompt into a denial.
      filePreview = tool.filePreview ? await tool.filePreview(input, ctx).catch(() => undefined) : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ui.writeError(`Could not prepare "${tool.name}" for confirmation: ${message}`);
      return this.record(tool, riskKey, ctx, "deny", "prepare_error");
    }
    // Notification hooks exist so a user can be pinged (sound, desktop
    // notification) when the agent is waiting on them — fire-and-forget, so a
    // slow hook never delays the prompt itself.
    void this.runLifecycleHook("Notification", ctx.cwd, ctx.sessionId, { message: `Permission needed to run "${tool.name}"` });
    const answer = await this.promptUser(tool.name, summary, preview, toolCallId, filePreview);

    if (answer === "always") this.sessionAllowlist.add(key);
    if (answer === "always-tool") this.sessionAllowlist.add(tool.name);
    return this.record(tool, riskKey, ctx, answer === "deny" ? "deny" : "allow", "user_prompt");
  }

  private async promptUser(toolName: string, summary: string, preview?: string, toolCallId?: string, filePreview?: FilePreview): Promise<AskAnswer> {
    const previewBlock = preview ? `\n${preview}\n` : "";
    // Spelled out explicitly which tool "always" scopes to — "[t]ool always
    // allowed" alone reads to some users as "any tool", when it only ever
    // covers this exact tool name (e.g. choosing it for "bash" never covers
    // "write_file" or "edit_file" — those are separate tools needing their
    // own opt-in).
    const prompt =
      `\nfinanfa-code wants to run "${toolName}": ${summary}${previewBlock}\n` +
      `[y]es / [n]o / [a]lways this exact action this session / [t] always allow "${toolName}" this session > `;
    // Unrecognized input (a typo, an empty line, a question instead of an
    // answer) used to fall through to "allow" by default — on a "dangerous"
    // tool, a mistyped keystroke could silently execute the command. Fails
    // closed instead: re-prompt until a recognized answer comes back.
    for (;;) {
      const raw = (await this.ui.askUser(prompt, "confirm", toolCallId, filePreview)).trim().toLowerCase();
      switch (raw) {
        case "a":
        case "always":
          return "always";
        case "t":
        case "tool":
          return "always-tool";
        case "n":
        case "no":
          return "deny";
        case "y":
        case "yes":
          return "allow";
        default:
          this.ui.writeError(`Unrecognized answer "${raw}", please answer y/n/a/t.`);
      }
    }
  }
}
