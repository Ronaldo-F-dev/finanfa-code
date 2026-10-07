// The effort level of a session: how much the CURRENT model should think before it answers, like Claude Code's
// /effort. It never changes the model, the tools or the provider, it only shapes each request:
//  - Anthropic: extended-thinking budget (low turns it off);
//  - Gemini (OpenAI-compatible endpoint): the reasoning_effort parameter;
//  - every model: a one-line instruction in the system prompt, which is the only lever a local model has.
// (The older model presets in effort-tiers.ts stay for the VS Code extension and for the "legal" specialist.)

export type EffortLevel = "low" | "medium" | "high";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high"];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return value === "low" || value === "medium" || value === "high";
}

/** Medium is the default level and must change nothing: it keeps whatever thinking budget the configuration already sets. */
export const DEFAULT_EFFORT_LEVEL: EffortLevel = "medium";

/**
 * Extended-thinking token budget for Anthropic models; undefined means no extended thinking. Low turns it off, high
 * turns it up, medium leaves the configured budget (if any) alone.
 */
export function thinkingBudgetFor(level: EffortLevel, configured?: number): number | undefined {
  if (level === "low") return undefined;
  return level === "high" ? 16384 : configured;
}

/** The instruction added to the system prompt; medium is the model's normal behaviour, so it adds nothing. */
export function effortPromptFor(level: EffortLevel | undefined): string {
  if (level === "low") return "\n\nEffort level: low. Answer directly and briefly, and skip extended reasoning unless the task clearly needs it.";
  if (level === "high") return "\n\nEffort level: high. Think carefully, consider alternatives, and check your work before you answer or finish.";
  return "";
}
