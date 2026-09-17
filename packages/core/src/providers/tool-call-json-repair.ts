// Best-effort repair for streamed tool-call argument JSON that failed to
// parse as-is — closes brace/bracket/quote nesting a stream got cut off
// before finishing (the single most common real failure mode: the
// connection or the model's own output stopped mid-argument, not a
// genuine syntax error), and drops a trailing comma the closing may have
// exposed. Deliberately narrow: only ever "finishes" nesting that was
// left open, never guesses at or rewrites content — a real syntax error
// unrelated to truncation (a stray unescaped control character, say)
// isn't a truncation, so this returns undefined and the caller's own
// existing malformed/truncated-JSON marker fields still apply for that
// case, same as before this existed.

/** Computes the exact closing characters (`"`,`}`,`]`, in the right order) a truncated JSON fragment is missing, or undefined if `raw` isn't simply "cut off early" (mismatched brackets, or already balanced). */
function computeMissingClosers(raw: string): string | undefined {
  const closerStack: string[] = [];
  let inString = false;
  let escapeNext = false;

  for (const ch of raw) {
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      closerStack.push("}");
    } else if (ch === "[") {
      closerStack.push("]");
    } else if (ch === "}" || ch === "]") {
      if (closerStack.pop() !== ch) return undefined; // a real mismatch, not a truncation — give up rather than guess
    }
  }

  if (!inString && closerStack.length === 0) return undefined; // already balanced — nothing to repair here
  return (inString ? '"' : "") + closerStack.reverse().join("");
}

/**
 * Attempts to repair `raw` (tool-call arguments JSON that already failed
 * `JSON.parse`) by closing whatever nesting a truncated stream left open,
 * then re-parsing — trying once more with a trailing comma stripped (the
 * closing itself can expose one, e.g. `{"a":1,` + `}`). Returns the
 * parsed value on success, or undefined if this specific repair doesn't
 * make it valid JSON.
 */
export function repairTruncatedToolCallJson(raw: string): unknown | undefined {
  const missingClosers = computeMissingClosers(raw);
  if (missingClosers === undefined) return undefined;

  const candidate = raw + missingClosers;
  try {
    return JSON.parse(candidate);
  } catch {
    // fall through
  }

  const withoutTrailingComma = candidate.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(withoutTrailingComma);
  } catch {
    return undefined;
  }
}
