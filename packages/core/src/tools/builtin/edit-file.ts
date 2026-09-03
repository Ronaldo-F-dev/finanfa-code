import { readFile, writeFile } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
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

function applyEdit(before: string, input: EditFileInput): string {
  const occurrences = countOccurrences(before, input.old_string);
  if (occurrences === 0) {
    throw new Error(`old_string not found in ${input.path}`);
  }
  if (occurrences > 1 && !input.replace_all) {
    throw new Error(
      `old_string occurs ${occurrences} times in ${input.path}; pass replace_all:true or provide more context to make it unique`,
    );
  }
  return input.replace_all
    ? before.split(input.old_string).join(input.new_string)
    : before.replace(input.old_string, input.new_string);
}

export const editFileTool: ToolDefinition<EditFileInput> = {
  name: "edit_file",
  description:
    "Replace an exact string occurrence in a file with new content. old_string must match the file content exactly and occur exactly once, unless replace_all is set.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root, or an absolute path (e.g. under the user's home directory)" },
      old_string: { type: "string", description: "Exact text to find" },
      new_string: { type: "string", description: "Text to replace it with" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness" },
    },
    required: ["path", "old_string", "new_string"],
  },
  riskKey: (input) => input.path,
  describeCall: (input) => `edit ${input.path}`,
  async preview(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const before = await readFile(filePath, "utf-8");
    const after = applyEdit(before, input);
    return createTwoFilesPatch(input.path, input.path, before, after);
  },
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const before = await readFile(filePath, "utf-8");
    const staleWarning = ctx.fileFreshness?.checkStale(filePath, before);
    const after = applyEdit(before, input);
    await writeFile(filePath, after, "utf-8");
    ctx.history?.push({ path: filePath, before });
    ctx.fileFreshness?.record(filePath, after);
    const diff = createTwoFilesPatch(input.path, input.path, before, after);
    return { content: staleWarning ? `${staleWarning}\n${diff}` : diff, isError: false };
  },
};
