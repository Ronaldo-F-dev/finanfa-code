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
