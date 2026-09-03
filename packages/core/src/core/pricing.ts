// USD per million tokens, by model id.
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Unknown model id (local model, free-tier provider, ...) → assume $0 rather
  // than silently borrowing Anthropic pricing for an unrelated model.
  const rate = PRICING[model] ?? { input: 0, output: 0 };
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}
