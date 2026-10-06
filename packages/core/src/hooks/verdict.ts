export interface HookVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Pulls the verdict out of a model's reply. Models often wrap the JSON in prose or a code fence, so
 * this takes the LAST well-formed JSON object that has a boolean `ok` — the final answer, not an
 * example the model quoted earlier. Returns undefined when there is none.
 */
export function parseHookVerdict(text: string): HookVerdict | undefined {
  const end = text.lastIndexOf("}");
  if (end === -1) return undefined;
  for (let start = text.lastIndexOf("{", end); start !== -1; start = start > 0 ? text.lastIndexOf("{", start - 1) : -1) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { ok?: unknown; reason?: unknown };
      if (typeof parsed.ok === "boolean") return { ok: parsed.ok, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
    } catch {
      // not a JSON object at this brace — try the previous one
    }
  }
  return undefined;
}
