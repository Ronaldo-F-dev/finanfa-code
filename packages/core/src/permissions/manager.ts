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

  private riskKey(tool: ToolDefinition, input: unknown): string {
    return tool.riskKey ? tool.riskKey(input) : tool.name;
  }

  private matchRule(tool: ToolDefinition, key: string): PermissionDecision | undefined {
    for (const rule of this.config.rules) {
      if (rule.tool !== "*" && rule.tool !== tool.name) continue;
      if (rule.keyPrefix && !key.startsWith(rule.keyPrefix)) continue;
      return rule.decision;
    }
    return undefined;
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

  async check(tool: ToolDefinition, input: unknown, ctx: ToolContext): Promise<PermissionDecision> {
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
    const answer = await this.promptUser(tool.name, summary, preview);

    if (answer === "always") this.sessionAllowlist.add(key);
    if (answer === "always-tool") this.sessionAllowlist.add(tool.name);
    return answer === "deny" ? "deny" : "allow";
  }

  private async promptUser(toolName: string, summary: string, preview?: string): Promise<AskAnswer> {
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
      const raw = (await this.ui.askUser(prompt, "confirm")).trim().toLowerCase();
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
