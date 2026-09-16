import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";

// Real end-to-end test of `finanfa --acp`: a real spawned CLI subprocess
// speaking real newline-delimited JSON-RPC over its actual stdin/stdout
// (run in-process the way cli-prompt-mode.test.ts does main() would hijack
// this test process's own stdin/stdout), driven by the official ACP
// TypeScript SDK's own client builder — the same one an ACP-aware editor
// like Zed uses — against a real local HTTP server playing the
// OpenAI-compatible chat-completions SSE protocol.

const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function withAcpAgent<T>(projectDir: string, run: (ctx: acp.ClientContext) => Promise<T>): Promise<T> {
  const agentProcess: ChildProcessWithoutNullStreams = spawn("npx", ["tsx", "bin/finanfa.ts", "--acp", "--cwd", projectDir], {
    cwd: cliDir,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  agentProcess.stderr.on("data", () => {}); // drained, not asserted on — real stderr noise (experimental warnings) is expected

  try {
    const input = Writable.toWeb(agentProcess.stdin);
    const output = Readable.toWeb(agentProcess.stdout);
    const stream = acp.ndJsonStream(input, output);

    return await acp
      .client({ name: "test-client" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => Promise.resolve({ outcome: { outcome: "selected", optionId: ctx.params.options[0]!.optionId } }))
      .onRequest(acp.methods.client.fs.writeTextFile, () => Promise.resolve({}))
      .onRequest(acp.methods.client.fs.readTextFile, () => Promise.resolve({ content: "" }))
      .connectWith(stream, run);
  } finally {
    agentProcess.kill();
  }
}

describe("finanfa --acp (real subprocess, real ACP client from the official SDK, real fake LLM server)", () => {
  let projectDir: string;
  let server: http.Server;
  let baseUrl: string;
  let scriptedResponses: string[];
  let requestCount: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const response = scriptedResponses[requestCount] ?? scriptedResponses.at(-1)!;
        requestCount++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${response}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function freshProject(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-acp-project-"));
    await mkdir(path.join(dir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(dir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl, model: "test-model", apiKey: "test-key" }),
    );
    return dir;
  }

  it(
    "initializes, creates a session, and streams a real plain-text reply",
    async () => {
      projectDir = await freshProject();
      scriptedResponses = [
        JSON.stringify({ choices: [{ delta: { content: "PONG" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      ];
      requestCount = 0;

      const result = await withAcpAgent(projectDir, async (ctx) => {
        const initResult = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        expect(initResult.protocolVersion).toBe(acp.PROTOCOL_VERSION);

        return ctx.buildSession(projectDir).withSession(async (session) => {
          expect(session.sessionId).toBeTruthy();
          session.prompt("say something");

          const chunks: string[] = [];
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") return { stopReason: message.response.stopReason, chunks };
            const update = message.notification.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") chunks.push(update.content.text);
          }
        });
      });

      expect(result.stopReason).toBe("end_turn");
      expect(result.chunks.join("")).toBe("PONG");
      await rm(projectDir, { recursive: true, force: true });
    },
    30_000,
  );

  it(
    "runs a real bash tool call end to end, including a real permission request",
    async () => {
      projectDir = await freshProject();
      scriptedResponses = [
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call1", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }] } }],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      ];
      requestCount = 0;

      const result = await withAcpAgent(projectDir, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        return ctx.buildSession(projectDir).withSession(async (session) => {
          session.prompt("run echo hi");

          const toolCallIds = new Set<string>();
          const toolCallStatuses: string[] = [];
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") return { stopReason: message.response.stopReason, toolCallIds: [...toolCallIds], toolCallStatuses };
            const update = message.notification.update;
            if (update.sessionUpdate === "tool_call") toolCallIds.add(update.toolCallId);
            if (update.sessionUpdate === "tool_call_update") toolCallStatuses.push(update.status ?? "");
          }
        });
      });

      expect(result.stopReason).toBe("end_turn");
      expect(result.toolCallIds).toEqual(["call1"]);
      expect(result.toolCallStatuses).toContain("completed");
      await rm(projectDir, { recursive: true, force: true });
    },
    30_000,
  );
});
