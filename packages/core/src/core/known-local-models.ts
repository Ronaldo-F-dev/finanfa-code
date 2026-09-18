/**
 * Real-tested compatibility notes for local models, surfaced by /models
 * next to a detected model's name. Every entry here comes from an actual,
 * reproduced session against that model through finanfa-code's own tool
 * pipeline — not a spec sheet or a vendor's own claims (a model's system
 * prompt/card can say anything; see the ducquoc/gemma4-fast-sonnet entry
 * below for a real example of that not matching reality). Keep entries
 * narrow and evidence-based: what was actually observed, not a general
 * verdict on the model that wasn't directly tested.
 */
export interface KnownModelNote {
  /** Matched case-insensitively against the model id substring (e.g. "yi-coder", not a full registry path). */
  pattern: string;
  note: string;
}

export const KNOWN_LOCAL_MODEL_NOTES: readonly KnownModelNote[] = [
  {
    pattern: "lfm2.5-thinking",
    note:
      "Real tested behavior: struggles badly with finanfa's tool-search indirection (search_tools/describe_tool/" +
      "call_tool) — reasons in circles and concludes it has no way to write files, even though the tool exists. " +
      "Works much better with the full tool list: /config set toolSearch false before using this model.",
  },
  {
    pattern: "laguna-xs",
    note:
      "Real tested behavior: understands tool calls and finanfa's search_tools indirection reasonably well, " +
      "but unreliable for large file content — may switch to write_file's content_base64 field and fabricate " +
      "invalid base64 (looks right at a glance, decodes to garbage) instead of raising an error. Fine for short " +
      "files/commands; verify anything it writes that's more than a few dozen lines.",
  },
  {
    pattern: "gemma4-fast-sonnet",
    note:
      'Real tested behavior: reliable tool use (multi-file writes, valid JSON args, no timeouts) despite the ' +
      'model\'s own system prompt claiming to be "distilled from Claude Sonnet 4.6" — an unverifiable, almost ' +
      "certainly inaccurate claim from whoever uploaded it, not something finanfa-code confirms or relies on. " +
      "Code correctness for anything beyond a single simple file is not reliable — a real test asking for a " +
      "multi-file Flask+SQLAlchemy API produced code that crashed immediately (missing db.init_app) and used a " +
      "nonsensical raw HTTPServer instead of app.run(). Review generated code for non-trivial tasks.",
  },
] as const;

/** Case-insensitive substring match against a model id — the same convention Ollama/registry model names already use loosely (e.g. "author/name:tag"). */
export function findKnownModelNote(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  return KNOWN_LOCAL_MODEL_NOTES.find((entry) => lower.includes(entry.pattern.toLowerCase()))?.note;
}
