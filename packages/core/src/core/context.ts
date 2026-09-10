import type { NeutralMessage } from "./types.js";

// Character-per-token is a rough estimate (no tokenizer dependency) — good
// enough for a budget check, same trust level as the provider's own usage
// reporting for backends that don't return real token counts.
// Exported for loop.ts's own pre-call size estimate (system prompt + tool
// schemas + messages) — same rough trust level, kept as one constant so the
// two estimates can't silently drift apart.
export const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_TOKEN_BUDGET = 60_000;
const KEEP_RECENT_TOOL_MESSAGES = 2;
const MIN_RESULT_LENGTH_TO_COMPACT = 500;

function messageLength(m: NeutralMessage): number {
  if (m.role === "tool") return m.results.reduce((n, r) => n + r.content.length, 0);
  return m.content.length;
}

/**
 * Returns a copy of `messages` sized for a provider call, with older tool
 * results collapsed to a short placeholder once the conversation's estimated
 * size exceeds `tokenBudget` — a full page dump from `web_fetch`/`browser_navigate`
 * pulled in three turns ago is rarely still needed verbatim, and left
 * unbounded it silently balloons every subsequent request (seen for real:
 * a duplicate page fetch put a two-turn conversation at 76k input tokens).
 * The most recent `keepRecentToolMessages` tool-result messages are always
 * left intact. This never touches `session.messages` itself — only what
 * gets sent to the model for this one call.
 */
export function compactForProvider(
  messages: NeutralMessage[],
  tokenBudget = DEFAULT_TOKEN_BUDGET,
  keepRecentToolMessages = KEEP_RECENT_TOOL_MESSAGES,
): NeutralMessage[] {
  const charBudget = tokenBudget * CHARS_PER_TOKEN_ESTIMATE;
  const totalChars = messages.reduce((n, m) => n + messageLength(m), 0);
  if (totalChars <= charBudget) return messages;

  const toolMessageIndices: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") toolMessageIndices.push(i);
  });
  const protectedIndices = new Set(toolMessageIndices.slice(-keepRecentToolMessages));

  return messages.map((m, i) => {
    if (m.role !== "tool" || protectedIndices.has(i)) return m;
    return {
      ...m,
      results: m.results.map((r) =>
        r.content.length <= MIN_RESULT_LENGTH_TO_COMPACT
          ? r
          : { ...r, content: `[earlier tool output omitted to save context — ${r.content.length} chars]` },
      ),
    };
  });
}
