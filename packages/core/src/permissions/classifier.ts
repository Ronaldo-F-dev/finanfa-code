import type { LlmProvider, ToolDefinition } from "../core/types.js";

export type ClassifiedRisk = "low" | "medium" | "high";

export interface RiskClassification {
  risk: ClassifiedRisk;
  justification: string;
}

export interface AutoApprovalClassifierConfig {
  enabled: boolean;
  /**
   * Model id used ONLY for classification calls, never the main
   * conversation model. Defaults to a small local model (gemma2:2b).
   */
  model?: string;
}

const CLASSIFIER_TIMEOUT_MS = 10_000;

/** The model used when nothing is configured: a small local one, as before (the "low" effort level no longer names a model of its own, so it cannot be asked). */
const DEFAULT_CLASSIFIER_MODEL = "gemma2:2b";

/** An explicit config.model always wins; an empty one counts as unset. */
export function resolveClassifierModel(config: AutoApprovalClassifierConfig | undefined): string {
  return config?.model?.trim() || DEFAULT_CLASSIFIER_MODEL;
}

function buildClassifierPrompt(tool: ToolDefinition, input: unknown): string {
  const inputJson = (() => {
    try {
      return JSON.stringify(input);
    } catch {
      return String(input);
    }
  })();
  return (
    `Classify the ACTUAL risk of this one tool call, its real arguments, not just the tool's general category.\n\n` +
    `Tool: ${tool.name}\nArguments: ${inputJson}\n\n` +
    `Respond with ONLY a JSON object, no other text: {"risk": "low"|"medium"|"high", "justification": "<one short sentence>"}\n` +
    `low: read-only or trivially reversible, no meaningful blast radius.\n` +
    `medium: makes a real, scoped change that's expected and reversible (e.g. editing a file already being worked on).\n` +
    `high: destructive or hard to reverse, touches secrets/credentials, runs unreviewed/arbitrary code, or has a wide blast radius.`
  );
}

function parseClassification(raw: string): RiskClassification | undefined {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { risk?: unknown; justification?: unknown };
    if (parsed.risk === "low" || parsed.risk === "medium" || parsed.risk === "high") {
      return { risk: parsed.risk, justification: typeof parsed.justification === "string" ? parsed.justification : "" };
    }
  } catch {
    // Falls through to undefined below — an unparseable response is treated
    // exactly like any other classifier failure by the caller (fail open to "ask").
  }
  return undefined;
}

/**
 * Scores one tool call's real risk via an actual (cheap/fast) LLM call —
 * this supplements, never replaces, the static per-tool-category
 * defaultForRiskLevel/rules logic (see PermissionManager.check, which only
 * calls this for a call that would otherwise land on "ask").
 *
 * Returns undefined on ANY failure — provider error, timeout, or an
 * unparseable response. Callers MUST treat undefined as "ask", never
 * "allow": auto-running something because the classifier itself broke
 * would defeat the entire point of having one.
 */
export async function classifyToolRisk(
  provider: LlmProvider,
  model: string,
  tool: ToolDefinition,
  input: unknown,
  signal?: AbortSignal,
): Promise<RiskClassification | undefined> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), CLASSIFIER_TIMEOUT_MS);
  const onOuterAbort = () => timeoutController.abort();
  signal?.addEventListener("abort", onOuterAbort);
  try {
    const result = await provider.streamTurn({
      model,
      systemPrompt: "You are a terse, precise risk classifier for an autonomous coding agent's tool calls. Output only the requested JSON, nothing else.",
      messages: [{ role: "user", content: buildClassifierPrompt(tool, input) }],
      tools: [],
      onTextDelta: () => {},
      signal: timeoutController.signal,
      maxTokens: 200,
    });
    return parseClassification(result.assistantMessage.content);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}
