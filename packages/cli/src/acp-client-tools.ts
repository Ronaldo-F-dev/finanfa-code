import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { ToolDefinition } from "@finanfa/core/src/core/types.js";
import { resolveAllowedPath } from "@finanfa/core/src/tools/builtin/path-guard.js";
import { readFileTool } from "@finanfa/core/src/tools/builtin/read-file.js";
import { writeFileTool } from "@finanfa/core/src/tools/builtin/write-file.js";
import { createBashTool } from "@finanfa/core/src/tools/builtin/bash.js";
import type { SandboxConfig } from "@finanfa/core/src/util/sandbox.js";

// An ACP client (Zed, or another ACP-aware editor) may run finanfa-code
// against its OWN view of the filesystem/terminal — a remote workspace, a
// virtual/sandboxed FS, an unsaved-buffer overlay a plain fs.readFile would
// never see — rather than the process's own. initialize's clientCapabilities
// says which of fs/terminal it actually implements; only then do read_file/
// write_file/bash get rerouted through it (see wireAcpClientTools below).
// Never used unconditionally: a client that advertises nothing keeps every
// tool's normal direct-filesystem/subprocess behavior, unchanged from a
// terminal session.

type Requester = { request: typeof acp.AgentContext.prototype.request };

const DEFAULT_LIMIT = 2000;

/** Same line-numbering/truncation presentation as the direct read_file tool, applied to content the client (not this process) actually read. */
function formatRead(content: string, offset: number | undefined, limit: number | undefined): { content: string; totalLines: number } {
  const lines = content.split("\n");
  const start = Math.max(0, (offset ?? 1) - 1);
  const effectiveLimit = limit ?? DEFAULT_LIMIT;
  const slice = lines.slice(start, start + effectiveLimit);
  const truncated = start + effectiveLimit < lines.length;
  const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join("\n");
  return { content: truncated ? `${numbered}\n... (truncated, ${lines.length} lines total)` : numbered, totalLines: lines.length };
}

/**
 * read_file routed through `fs/read_text_file` — only registered when the
 * client advertised `clientCapabilities.fs.readTextFile` at initialize.
 * Falls back to the normal direct-filesystem tool on any request error (a
 * client that flakes mid-session shouldn't make every subsequent read fail
 * outright).
 */
export function createAcpReadFileTool(cx: Requester, sessionId: string): ToolDefinition<{ path: string; offset?: number; limit?: number }> {
  return {
    ...readFileTool,
    async handler(input, ctx) {
      const filePath = resolveAllowedPath(ctx.cwd, input.path);
      try {
        const response = await cx.request(acp.methods.client.fs.readTextFile, {
          sessionId,
          path: filePath,
          line: input.offset ?? null,
          limit: input.limit ?? null,
        });
        const { content, totalLines } = formatRead(response.content, input.offset, input.limit);
        if ((input.offset ?? 1) === 1 && !input.limit) ctx.fileFreshness?.record(filePath, response.content);
        return { content, isError: false, metadata: { totalLines } };
      } catch {
        return readFileTool.handler(input, ctx);
      }
    },
  };
}

/**
 * write_file routed through `fs/write_text_file` — only registered when the
 * client advertised `clientCapabilities.fs.writeTextFile`. The diff/preview
 * and staleness check still read the CLIENT's copy of the file (via
 * fs/read_text_file when readTextFile is also available, otherwise this
 * process's own view) so the preview shown for permission reflects what the
 * client will actually overwrite.
 */
export function createAcpWriteFileTool(
  cx: Requester,
  sessionId: string,
  clientReadsFiles: boolean,
): ToolDefinition<{ path: string; content?: string; content_base64?: string }> {
  return {
    ...writeFileTool,
    async preview(input, ctx) {
      if (!clientReadsFiles) return writeFileTool.preview!(input, ctx);
      const filePath = resolveAllowedPath(ctx.cwd, input.path);
      const before = await cx
        .request(acp.methods.client.fs.readTextFile, { sessionId, path: filePath, line: null, limit: null })
        .then((r) => r.content)
        .catch(() => "");
      const content = input.content ?? (input.content_base64 ? Buffer.from(input.content_base64, "base64").toString("utf-8") : "");
      const { createTwoFilesPatch } = await import("diff");
      return createTwoFilesPatch(input.path, input.path, before, content);
    },
    async handler(input, ctx) {
      const resolved =
        input.content !== undefined
          ? { content: input.content }
          : input.content_base64 !== undefined
            ? { content: Buffer.from(input.content_base64, "base64").toString("utf-8") }
            : undefined;
      if (!resolved) return writeFileTool.handler(input, ctx);

      const filePath = resolveAllowedPath(ctx.cwd, input.path);
      try {
        await cx.request(acp.methods.client.fs.writeTextFile, { sessionId, path: filePath, content: resolved.content });
        ctx.fileFreshness?.record(filePath, resolved.content);
        return { content: `Wrote ${input.path} via the ACP client (${resolved.content.length} bytes)`, isError: false };
      } catch {
        return writeFileTool.handler(input, ctx);
      }
    },
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_BYTE_LIMIT = 1_000_000;

/**
 * bash routed through `terminal/create` + `terminal/wait_for_exit` +
 * `terminal/output` + `terminal/release` — only registered when the client
 * advertised `clientCapabilities.terminal`. Falls back to this process's own
 * sandboxed subprocess runner (createBashTool) on any client-side error.
 */
export function createAcpBashTool(cx: Requester, sessionId: string, sandboxConfig?: SandboxConfig): ToolDefinition<{ command: string; timeout_ms?: number; cwd?: string }> {
  const fallback = createBashTool(sandboxConfig);
  return {
    ...fallback,
    async handler(input, ctx) {
      const cwd = input.cwd ? path.resolve(ctx.cwd, input.cwd) : ctx.cwd;
      let terminalId: string | undefined;
      try {
        const created = await cx.request(acp.methods.client.terminal.create, {
          sessionId,
          command: "/bin/bash",
          args: ["-c", input.command],
          cwd,
          outputByteLimit: OUTPUT_BYTE_LIMIT,
        });
        terminalId = created.terminalId;

        const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
        const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
        const exited = cx.request(acp.methods.client.terminal.waitForExit, { sessionId, terminalId });
        const outcome = await Promise.race([exited, timeout]);

        if (outcome === "timeout") {
          await cx.request(acp.methods.client.terminal.kill, { sessionId, terminalId });
        }
        const { output, truncated } = await cx.request(acp.methods.client.terminal.output, { sessionId, terminalId });
        const status = outcome === "timeout" ? "killed after timeout" : `exit ${outcome.exitCode ?? "?"}${outcome.signal ? ` (signal ${outcome.signal})` : ""}`;
        const isError = outcome === "timeout" || Boolean(outcome.exitCode);
        return { content: `${output}${truncated ? "\n... (truncated)" : ""}\n[${status}]`, isError };
      } catch {
        return fallback.handler(input, ctx);
      } finally {
        if (terminalId) await cx.request(acp.methods.client.terminal.release, { sessionId, terminalId }).catch(() => undefined);
      }
    },
  };
}
