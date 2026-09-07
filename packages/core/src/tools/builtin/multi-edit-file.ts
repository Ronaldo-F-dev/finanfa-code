import { readFile, writeFile } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

// Aider/Claude Code's own MultiEdit pattern: apply several exact-string
// edits to a SINGLE file in one call, atomically — either all of them
// apply cleanly or none of them are written to disk. Reduces round trips
// for a multi-hunk change to one file (e.g. renaming a symbol used in
// several places with different surrounding context) vs. one edit_file
// call per hunk, and — unlike calling edit_file repeatedly — a mistake
// partway through never leaves the file in a half-edited state.
interface SingleEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface MultiEditFileInput {
  path: string;
  edits: SingleEdit[];
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

function applySingleEdit(before: string, edit: SingleEdit, path: string, editIndex: number): string {
  const occurrences = countOccurrences(before, edit.old_string);
  if (occurrences === 0) {
    throw new Error(`edit #${editIndex + 1}: old_string not found in ${path} (after applying the preceding edits, if any)`);
  }
  if (occurrences > 1 && !edit.replace_all) {
    throw new Error(`edit #${editIndex + 1}: old_string occurs ${occurrences} times in ${path}; pass replace_all:true or provide more context to make it unique`);
  }
  return edit.replace_all ? before.split(edit.old_string).join(edit.new_string) : before.replace(edit.old_string, edit.new_string);
}

function applyAllEdits(before: string, input: MultiEditFileInput): string {
  if (input.edits.length === 0) throw new Error("edits must contain at least one edit");
  let current = before;
  for (const [i, edit] of input.edits.entries()) {
    current = applySingleEdit(current, edit, input.path, i);
  }
  return current;
}

export const multiEditFileTool: ToolDefinition<MultiEditFileInput> = {
  name: "multi_edit_file",
  description:
    "Apply multiple exact-string edits to a single file in one call, atomically: each edit is applied in order " +
    "against the result of the previous ones, and either every edit applies cleanly or NONE of them are " +
    "written to disk. Each edit's old_string must match exactly and occur exactly once, unless replace_all is " +
    "set for that edit. Prefer this over several edit_file calls when making multiple related changes to the " +
    "same file — it's one confirmation instead of several, and never leaves the file half-edited.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root, or an absolute path (e.g. under the user's home directory)" },
      edits: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Exact text to find" },
            new_string: { type: "string", description: "Text to replace it with" },
            replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness" },
          },
          required: ["old_string", "new_string"],
        },
        description: "Edits to apply in order, each against the result of the previous one",
      },
    },
    required: ["path", "edits"],
  },
  riskKey: (input) => input.path,
  describeCall: (input) => `edit ${input.path} (${input.edits.length} change${input.edits.length === 1 ? "" : "s"})`,
  async preview(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const before = await readFile(filePath, "utf-8");
    const after = applyAllEdits(before, input);
    return createTwoFilesPatch(input.path, input.path, before, after);
  },
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const before = await readFile(filePath, "utf-8");
    const staleWarning = ctx.fileFreshness?.checkStale(filePath, before);
    const after = applyAllEdits(before, input);
    await writeFile(filePath, after, "utf-8");
    ctx.history?.push({ path: filePath, before });
    ctx.fileFreshness?.record(filePath, after);
    const diff = createTwoFilesPatch(input.path, input.path, before, after);
    return { content: staleWarning ? `${staleWarning}\n${diff}` : diff, isError: false };
  },
};
