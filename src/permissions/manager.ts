import type { ToolContext, ToolDefinition } from "../core/types.js";
import type { UIAdapter } from "../ui/adapter.js";
import type { PermissionConfig, PermissionDecision } from "./config.js";

export type AskAnswer = "allow" | "deny" | "always" | "always-tool";

export interface PermissionManagerOptions {
  config: PermissionConfig;
  ui: UIAdapter;
  /** If true, never prompt: auto-deny anything not pre-allowed by config (fail safe). */
  nonInteractive?: boolean;
  /** If true, auto-approve everything without prompting (opt-in, scripted use). */
  yolo?: boolean;
}

export class PermissionManager {
  private readonly config: PermissionConfig;
  private readonly ui: UIAdapter;
  private readonly nonInteractive: boolean;
  private readonly yolo: boolean;
  private readonly sessionAllowlist = new Set<string>();

  constructor(opts: PermissionManagerOptions) {
    this.config = opts.config;
    this.ui = opts.ui;
    this.nonInteractive = opts.nonInteractive ?? false;
    this.yolo = opts.yolo ?? false;
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

  async check(tool: ToolDefinition, input: unknown, ctx: ToolContext): Promise<PermissionDecision> {
    if (this.yolo) return "allow";

    const key = `${tool.name}:${this.riskKey(tool, input)}`;
    if (this.sessionAllowlist.has(key) || this.sessionAllowlist.has(tool.name)) {
      return "allow";
    }

    const ruleDecision = this.matchRule(tool, this.riskKey(tool, input));
    const decision = ruleDecision ?? this.config.defaultForRiskLevel[tool.riskLevel];

    if (decision !== "ask") return decision;

    if (this.nonInteractive) return "deny";

    const summary = tool.describeCall ? tool.describeCall(input) : JSON.stringify(input);
    const preview = tool.preview ? await tool.preview(input, ctx) : undefined;
    const answer = await this.promptUser(tool.name, summary, preview);

    if (answer === "always") this.sessionAllowlist.add(key);
    if (answer === "always-tool") this.sessionAllowlist.add(tool.name);
    return answer === "deny" ? "deny" : "allow";
  }

  private async promptUser(toolName: string, summary: string, preview?: string): Promise<AskAnswer> {
    const previewBlock = preview ? `\n${preview}\n` : "";
    const prompt = `\nfinanfa-code wants to run "${toolName}": ${summary}${previewBlock}\n[y]es / [n]o / [a]lways this session / [t]ool always allowed > `;
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
      default:
        return "allow";
    }
  }
}
