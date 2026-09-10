import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

interface WriteFileInput {
  path: string;
  content?: string;
  content_base64?: string;
}

/**
 * Real reported bug: a model repeatedly generated invalid JSON tool-call
 * arguments for content with a lot of embedded quotes/newlines (e.g. Dart
 * source), cycling through bash heredocs, python_repl, and write_file
 * itself for many turns without ever reliably fixing its own escaping — the
 * fundamental problem (a JSON string argument containing arbitrary text)
 * doesn't go away by switching tools, since every tool-calling protocol
 * still needs that text encoded as a JSON string somewhere. base64 has no
 * quotes, backslashes, or newlines at all, so a model that's struggling to
 * escape raw content correctly has a mechanical, escaping-free alternative:
 * base64-encode the content itself instead of trying to get raw text past
 * strict JSON string escaping.
 */
function resolveContent(input: WriteFileInput): { content: string } | { error: string } {
  if (input.content !== undefined && input.content_base64 !== undefined) {
    return { error: 'Provide exactly one of "content" or "content_base64", not both.' };
  }
  if (input.content !== undefined) return { content: input.content };
  if (input.content_base64 !== undefined) {
    try {
      return { content: Buffer.from(input.content_base64, "base64").toString("utf-8") };
    } catch (err) {
      return { error: `content_base64 is not valid base64: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { error: 'Missing required field: provide "content" (or "content_base64" for content that\'s hard to JSON-escape — a lot of quotes/newlines).' };
}

export const writeFileTool: ToolDefinition<WriteFileInput> = {
  name: "write_file",
  description:
    "Create a file or overwrite it entirely with new content. Give `content` directly for most files. If the " +
    "content has a lot of embedded double quotes, backslashes, or newlines (e.g. generated source code) and " +
    "keeps failing to parse as valid JSON arguments, base64-encode it and pass that as `content_base64` " +
    "instead — base64 has none of those characters, so it never has this problem.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root, or an absolute path (e.g. under the user's home directory)" },
      content: { type: "string", description: "Full file content to write — use this for most files" },
      content_base64: {
        type: "string",
        description:
          "Base64-encoded file content — an alternative to `content` for text that's hard to JSON-escape correctly " +
          "(lots of quotes/backslashes/newlines). Provide exactly one of content or content_base64, not both.",
      },
    },
    required: ["path"],
  },
  riskKey: (input) => input.path,
  describeCall: (input) => {
    const resolved = resolveContent(input);
    return "error" in resolved ? `write ${input.path} (${resolved.error})` : `write ${input.path} (${resolved.content.length} bytes)`;
  },
  async preview(input, ctx) {
    const resolved = resolveContent(input);
    if ("error" in resolved) throw new Error(resolved.error);
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const before = await readFile(filePath, "utf-8").catch(() => "");
    return createTwoFilesPatch(input.path, input.path, before, resolved.content);
  },
  async handler(input, ctx) {
    const resolved = resolveContent(input);
    if ("error" in resolved) return { content: resolved.error, isError: true };
    const content = resolved.content;

    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const existing = await readFile(filePath, "utf-8").then(
      (c) => ({ existed: true, content: c }),
      () => ({ existed: false, content: "" }),
    );
    const staleWarning = existing.existed ? ctx.fileFreshness?.checkStale(filePath, existing.content) : undefined;
    const diff = createTwoFilesPatch(input.path, input.path, existing.content, content);

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    ctx.history?.push({ path: filePath, before: existing.existed ? existing.content : undefined });
    ctx.fileFreshness?.record(filePath, content);

    return { content: staleWarning ? `${staleWarning}\n${diff}` : diff, isError: false };
  },
};
