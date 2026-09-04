import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Named budget tiers, consolidating what had drifted into 4 different values
// across 8 independently-reimplemented truncate() functions with no visible
// rationale for the split (git.ts/query-database.ts/python-repl.ts used
// 50_000, documents.ts used 100_000 under a different name, grep.ts/
// http-request.ts used 20_000, browser.ts/web-fetch.ts used 8_000 inlined
// with no named constant at all) — reads as accidental drift, not a
// deliberate choice per tool. Picked by keeping each tool's own existing
// value bucketed into the nearest tier, not inventing new numbers.
export const TRUNCATE_LARGE = 100_000; // subprocess output, extracted document text
export const TRUNCATE_MEDIUM = 50_000; // git/SQL/REPL output
export const TRUNCATE_SMALL = 20_000; // grep matches, HTTP response bodies
export const TRUNCATE_TINY = 8_000; // web page text shown directly to the model

export function truncate(s: string, maxLength: number): string {
  return s.length > maxLength ? `${s.slice(0, maxLength)}\n... (truncated)` : s;
}

const SPILL_DIR = ".finanfa-code/spill";
// Per-process, not per-session — good enough to avoid two spills in the same
// session colliding on a filename within the same millisecond; session-scoped
// uniqueness comes from each session getting its own subdirectory below.
let spillCounter = 0;

/**
 * Saves `s` to disk under .finanfa-code/spill/<sessionId>/ and returns the
 * path, relative to `cwd` — the low-level primitive truncateOrSpill (below)
 * builds on; exported separately for callers (grep.ts) that need their own
 * preview-shaping logic (a line cap, not just a char cap) but still want the
 * full result saved rather than dropped.
 */
export async function spillToFile(cwd: string, sessionId: string, label: string, s: string): Promise<string> {
  const dir = path.join(cwd, SPILL_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  const relPath = path.join(".finanfa-code", "spill", sessionId, `${label}-${spillCounter++}.txt`);
  await writeFile(path.join(cwd, relPath), s, "utf-8");
  return relPath;
}

/**
 * Like truncate(), but instead of discarding the overflow outright, saves
 * the full text to disk under .finanfa-code/spill/<sessionId>/ and points
 * the model at it — read_file (with an offset) or grep can pull the rest
 * back in on demand, instead of it being permanently gone past the cutoff.
 * Mirrors the "spill" pattern from DeepSeek Harness (deepseek-ai/deepseek-
 * harness, packages/spill) — same idea, no shared code (that project's spill
 * lives inside its own plugin-runtime session/event-log machinery, which
 * finanfa-code doesn't have).
 */
export async function truncateOrSpill(cwd: string, sessionId: string, label: string, s: string, maxLength: number): Promise<string> {
  if (s.length <= maxLength) return s;

  const relPath = await spillToFile(cwd, sessionId, label, s);

  return (
    `${s.slice(0, maxLength)}\n... (truncated — full output is ${s.length.toLocaleString()} characters, saved to ` +
    `${relPath}; use read_file with an offset to read further into it, or grep it, rather than assuming this is everything)`
  );
}
