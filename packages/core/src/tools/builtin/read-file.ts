import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

interface ReadFileInput {
  path: string;
  offset?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 2000;

export const readFileTool: ToolDefinition<ReadFileInput> = {
  name: "read_file",
  description: "Read a text file from the project, with line numbers. Supports reading a slice via offset/limit.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root, or an absolute path (e.g. under the user's home directory)" },
      offset: { type: "number", description: "1-based line number to start from" },
      limit: { type: "number", description: "Maximum number of lines to return" },
    },
    required: ["path"],
  },
  describeCall: (input) => `read ${input.path}`,
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // A small model sometimes passes a page title or a URL here. Say what read_file is for and what to use instead,
      // rather than the bare "ENOENT" it cannot act on.
      return {
        content:
          `No such file: ${input.path}. read_file reads files of the project: use glob to find a file by name, and ` +
          "web_fetch (with an https:// address) to read a web page.",
        isError: true,
      };
    }
    const lines = raw.split("\n");

    const start = Math.max(0, (input.offset ?? 1) - 1);
    const limit = input.limit ?? DEFAULT_LIMIT;
    const slice = lines.slice(start, start + limit);
    const truncated = start + limit < lines.length;

    const numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
      .join("\n");

    if (start === 0 && !truncated) ctx.fileFreshness?.record(filePath, raw);

    return {
      content: truncated ? `${numbered}\n... (truncated, ${lines.length} lines total)` : numbered,
      isError: false,
      metadata: { totalLines: lines.length },
    };
  },
};
