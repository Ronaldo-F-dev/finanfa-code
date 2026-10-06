import { diffLines } from "diff";

export type DiffRow =
  | { kind: "ctx"; oldNo: number; newNo: number; text: string }
  | { kind: "add"; newNo: number; text: string }
  | { kind: "del"; oldNo: number; text: string }
  /** `hidden` unchanged lines collapsed between two hunks (or before the first / after the last change). */
  | { kind: "gap"; hidden: number };

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** Set when the inputs are too large to diff in the browser without freezing it. */
  tooLarge?: boolean;
}

/** A diff of this size would take noticeable time and be unreadable in a modal anyway; the caller falls back to plain text. */
const MAX_CHARS = 400_000;
const MAX_LINES = 8_000;

/** "a\nb\n" -> ["a", "b"] (a trailing newline ends the last line rather than starting an empty one). */
function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Line diff between two versions of a file, as rows ready to render: unchanged lines far from any change
 * are collapsed into a single "gap" row, keeping `context` lines around each change (like `diff -U`).
 */
export function buildDiffRows(before: string, after: string, context = 3): DiffResult {
  if (before.length + after.length > MAX_CHARS) return { rows: [], added: 0, removed: 0, tooLarge: true };

  const all: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const lines = splitLines(part.value);
    if (part.added) {
      for (const text of lines) all.push({ kind: "add", newNo: newNo++, text });
      added += lines.length;
    } else if (part.removed) {
      for (const text of lines) all.push({ kind: "del", oldNo: oldNo++, text });
      removed += lines.length;
    } else {
      for (const text of lines) all.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text });
    }
    if (all.length > MAX_LINES) return { rows: [], added: 0, removed: 0, tooLarge: true };
  }

  if (added === 0 && removed === 0) return { rows: [], added: 0, removed: 0 };

  // Keep every changed row, plus `context` rows on each side of it; collapse the rest.
  const keep = Array.from({ length: all.length }, () => false);
  all.forEach((row, i) => {
    if (row.kind === "ctx") return;
    for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) keep[j] = true;
  });

  const rows: DiffRow[] = [];
  let hidden = 0;
  all.forEach((row, i) => {
    if (keep[i]) {
      if (hidden > 0) rows.push({ kind: "gap", hidden });
      hidden = 0;
      rows.push(row);
    } else {
      hidden++;
    }
  });
  if (hidden > 0) rows.push({ kind: "gap", hidden });
  return { rows, added, removed };
}
