import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ToolDefinition } from "../../core/types.js";
import { resolveWithinCwd } from "./path-guard.js";

interface WriteFileInput {
  path: string;
  content: string;
}

export const writeFileTool: ToolDefinition<WriteFileInput> = {
  name: "write_file",
  description: "Create a file or overwrite it entirely with new content.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root" },
      content: { type: "string", description: "Full file content to write" },
    },
    required: ["path", "content"],
  },
  riskKey: (input) => input.path,
  describeCall: (input) => `write ${input.path} (${input.content.length} bytes)`,
  async preview(input, ctx) {
    const filePath = resolveWithinCwd(ctx.cwd, input.path);
    const before = await readFile(filePath, "utf-8").catch(() => "");
    return createTwoFilesPatch(input.path, input.path, before, input.content);
  },
  async handler(input, ctx) {
    const filePath = resolveWithinCwd(ctx.cwd, input.path);
    const before = await readFile(filePath, "utf-8").catch(() => "");
    const diff = createTwoFilesPatch(input.path, input.path, before, input.content);

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, input.content, "utf-8");

    return { content: diff, isError: false };
  },
};
