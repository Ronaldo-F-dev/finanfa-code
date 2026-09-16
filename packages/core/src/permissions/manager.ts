import type { ToolContext, ToolDefinition } from "../core/types.js";
import type { UIAdapter } from "../ui/adapter.js";
import type { PermissionConfig, PermissionDecision } from "./config.js";
import type { HooksConfig } from "../hooks/config.js";
import { runHooks } from "../hooks/runner.js";

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
}

export class PermissionManager {
  private readonly config: PermissionConfig;
  private readonly ui: UIAdapter;
  private readonly nonInteractive: boolean;
  private readonly yolo: boolean;
  private readonly hooksConfig?: HooksConfig;
  private readonly sessionAllowlist = new Set<string>();

  constructor(opts: PermissionManagerOptions) {
    this.config = opts.config;
    this.ui = opts.ui;
    this.nonInteractive = opts.nonInteractive ?? false;
    this.yolo = opts.yolo ?? false;
    this.hooksConfig = opts.hooksConfig;
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

  private matchRule(tool: ToolDefinition, key: string): PermissionDecision | undefined {
    for (const rule of this.config.rules) {
      if (rule.tool !== "*" && rule.tool !== tool.name) continue;
      if (rule.keyPrefix && !key.startsWith(rule.keyPrefix)) continue;
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
    const outcome = await runHooks(
      this.hooksConfig,
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
    const outcome = await runHooks(this.hooksConfig, "UserPromptSubmit", { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd, prompt }, cwd);
    if (outcome.decision === "block") return { blockedReason: outcome.reason ?? "Blocked by a UserPromptSubmit hook.", prompt };
    if (outcome.output) return { prompt: `${prompt}\n\n<user-prompt-submit-hook-context>\n${outcome.output}\n</user-prompt-submit-hook-context>` };
    return { prompt };
  }

  /** Returns a decision when a PreToolUse hook has an opinion (block/approve); undefined means the normal permission flow should decide instead. */
  private async checkPreToolUseHooks(tool: ToolDefinition, input: unknown, ctx: ToolContext): Promise<PermissionDecision | undefined> {
    if (!this.hooksConfig) return undefined;
    const outcome = await runHooks(
      this.hooksConfig,
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

  /** `toolCallId` is the model's own tool_use id for this call, if the caller has minted one yet (see loop.ts) — passed through to askUser so an adapter like the ACP bridge can correlate its permission request with the real tool_call, not a synthetic placeholder. */
  async check(tool: ToolDefinition, input: unknown, ctx: ToolContext, toolCallId?: string): Promise<PermissionDecision> {
    const hookDecision = await this.checkPreToolUseHooks(tool, input, ctx);
    if (hookDecision) return hookDecision;

    if (this.yolo) return "allow";

    const key = `${tool.name}:${this.riskKey(tool, input)}`;
    if (this.sessionAllowlist.has(key) || this.sessionAllowlist.has(tool.name)) {
      return "allow";
    }

    const ruleDecision = this.matchRule(tool, this.riskKey(tool, input));
    const decision = ruleDecision ?? this.config.defaultForRiskLevel[tool.riskLevel];

    if (decision !== "ask") return decision;

    if (this.nonInteractive) return "deny";

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
    try {
      summary = tool.describeCall ? tool.describeCall(input) : JSON.stringify(input);
      preview = tool.preview ? await tool.preview(input, ctx) : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ui.writeError(`Could not prepare "${tool.name}" for confirmation: ${message}`);
      return "deny";
    }
    const answer = await this.promptUser(tool.name, summary, preview, toolCallId);

    if (answer === "always") this.sessionAllowlist.add(key);
    if (answer === "always-tool") this.sessionAllowlist.add(tool.name);
    return answer === "deny" ? "deny" : "allow";
  }

  private async promptUser(toolName: string, summary: string, preview?: string, toolCallId?: string): Promise<AskAnswer> {
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
      const raw = (await this.ui.askUser(prompt, "confirm", toolCallId)).trim().toLowerCase();
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
          this.ui.writeError(`Unrecognized answer "${raw}" — please answer y/n/a/t.`);
      }
    }
  }
}
