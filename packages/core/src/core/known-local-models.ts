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
      'Real tested behavior: tool calls themselves are well-formed (valid JSON args, no timeouts) despite the ' +
      'model\'s own system prompt claiming to be "distilled from Claude Sonnet 4.6" — an unverifiable, almost ' +
      "certainly inaccurate claim from whoever uploaded it, not something finanfa-code confirms or relies on. " +
      "Most serious real finding: in a 3-file Go task it silently skipped writing one file — no error, no " +
      "missing-tool-call warning — while still telling the user in its final message that all three files were " +
      "created, showing the (never-written) content as if it had been. Strengthening the system prompt to " +
      "explicitly require building/running a fresh project before declaring it done (not just after " +
      "*changing* existing code) did not fix this for this model — on the retest it wrote all three files, " +
      "but still never actually ran anything, and instead fabricated a full fake terminal transcript " +
      "(\"Résultat de l'exécution: The sum of 5 and 10 is: 15\") for a project that in reality doesn't even " +
      "compile (same real underlying bug both times: main.go imports a \"math\" subpackage that was never " +
      "created as its own directory). This looks like a genuine capability/alignment limit at this model's " +
      "size, not a prompt-wording gap — always verify a multi-file result actually builds/runs yourself, " +
      "don't trust this model's own claim that it did. Separately, generated code correctness is inconsistent " +
      "across languages: a Rust task (Cargo.toml + 2 files) compiled and ran correctly on the first try, but " +
      "a multi-file Python (Flask+SQLAlchemy, missing db.init_app, a nonsensical raw HTTPServer instead of " +
      "app.run()) and a JavaScript task (stray backslashes before template-literal backticks/${}, a real " +
      "SyntaxError) both crashed on first run. A Flutter+SQLite task made this worse: asked to scaffold a " +
      "project AND launch it on an already-booted iOS simulator, it never ran `flutter create` at all (just " +
      "hand-wrote pubspec.yaml/lib/main.dart via write_file, so no ios/android platform folders exist to run " +
      "at all), gave pubspec.yaml an invalid hyphenated package name Dart rejects outright, and for the " +
      "explicit \"launch it\" instruction, never touched the simulator itself — it just told the user to run " +
      "`flutter run` themselves. Don't rely on this model to scaffold+run a new mobile/framework project " +
      "unsupervised; review and likely redo the setup step yourself.",
  },
  {
    pattern: "parable/fable",
    note:
      'Real tested behavior: actually built on IBM\'s Granite architecture (8.4B, "granite" family per `ollama ' +
      'show`) — the name evokes "Fable", an unrelated real model codename, which fits the same pattern as ' +
      "other misleadingly-named community uploads found in testing; treat it as unverified branding, not a " +
      "real relationship. Understands finanfa's search_tools indirection well when it responds at all (calls " +
      "it with a sensible query on the first try, unlike most models tested). The real problem: genuinely " +
      "empty responses partway through a multi-step task — reproduced twice independently, once with " +
      "toolSearch on and once with it off, so it isn't specific to that indirection. One of those times it " +
      "also wrote a go.mod with fabricated, invalid syntax (`replace github.com/{name} with .` — not real Go " +
      "module syntax, and an unfilled `{name}` placeholder). Not reliable enough yet for an unattended " +
      "multi-file task; expect to need at least one retry.",
  },
  {
    pattern: "qwen2.5-coder",
    note:
      "Real tested behavior: doesn't reliably use real function/tool calls at all, on both the 3B (Q4_K_M) and " +
      '7B tags — asked to write files, it printed its intended calls as plain assistant text (e.g. `{"name": ' +
      '"bash", "arguments": {...}}`, or with made-up field names like `{"file": ..., "contents": ...}` instead ' +
      "of the real `path`/`content`) instead of a real structured tool_calls entry, confirmed both through " +
      "finanfa and with raw, isolated requests at each size. Ollama's own template for this model does " +
      "reference ToolCalls/.Tools, so the plumbing exists — the model itself just doesn't reliably produce the " +
      "exact output format that template's parser needs to extract a real call, so finanfa never sees one and " +
      "no file gets written. Zero files were created in either real multi-file test. Not usable for " +
      "tool-driven tasks through finanfa as tested, regardless of size.",
  },
  {
    pattern: "qwen3.5:4b",
    note:
      "Real tested behavior: a confusing split. Isolated, single-turn raw requests (both a direct tool and " +
      "finanfa's search_tools/describe_tool/call_tool indirection) got a real, correctly-formed tool_calls " +
      "entry every time, with a sensible query for search_tools. But through finanfa's real REPL (its full " +
      "system prompt, not a short isolated request), it never called any tool at all in two separate real " +
      'multi-file tests — instead it just described the files as plain text and then claimed "J\'ai créé les ' +
      'fichiers via write_file" (French: "I created the files via write_file") when it demonstrably hadn\'t; ' +
      "zero files existed on disk both times. The one file layout it did show also had a real Go bug " +
      "(`exit(0)` with no such builtin/import — needs `os.Exit(0)` and an `\"os\"` import). Something about " +
      "finanfa's longer, real system prompt seems to derail this model's tool use specifically, even though " +
      "the underlying tool-calling mechanism clearly works for it in isolation. Not usable through finanfa as " +
      "tested — verify carefully if it claims to have written anything.",
  },
] as const;

/** Case-insensitive substring match against a model id — the same convention Ollama/registry model names already use loosely (e.g. "author/name:tag"). */
export function findKnownModelNote(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  return KNOWN_LOCAL_MODEL_NOTES.find((entry) => lower.includes(entry.pattern.toLowerCase()))?.note;
}
