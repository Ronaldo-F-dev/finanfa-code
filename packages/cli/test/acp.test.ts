import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";

// Every test here starts the real CLI as a subprocess (through tsx, several seconds of startup alone) and one starts two.
// With the other test files running in parallel those startups stretch well past the old 30s, and they passed alone every time.
const ACP_TEST_TIMEOUT_MS = 120_000;

// Real end-to-end test of `finanfa --acp`: a real spawned CLI subprocess
// speaking real newline-delimited JSON-RPC over its actual stdin/stdout
// (run in-process the way cli-prompt-mode.test.ts does main() would hijack
// this test process's own stdin/stdout), driven by the official ACP
// TypeScript SDK's own client builder — the same one an ACP-aware editor
// like Zed uses — against a real local HTTP server playing the
// OpenAI-compatible chat-completions SSE protocol.

const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const echoMcpFixture = path.join(cliDir, "../core/test/fixtures/echo-mcp-server.mjs");

interface WithAcpAgentOptions {
  onRequestPermission?: (toolCallId: string) => void;
  /** Client-side fs/read_text_file responder — only exercised by a test that advertises the fs.readTextFile capability at initialize. */
  fsReadTextFile?: (params: acp.ReadTextFileRequest) => acp.ReadTextFileResponse;
  /** Client-side terminal/* responders — only exercised by a test that advertises the terminal capability at initialize. */
  terminal?: {
    output?: acp.TerminalOutputResponse;
    waitForExit?: acp.WaitForTerminalExitResponse;
  };
  /** Fires for every session/update notification this connection receives — used by the session/load replay test, which drives session/load through a raw ctx.request (not buildSession/ActiveSession, since that helper only wraps session/new) and so needs its own way to observe the replayed notifications. */
  onSessionUpdate?: (notification: acp.SessionNotification) => void;
}

async function withAcpAgent<T>(projectDir: string, run: (ctx: acp.ClientContext) => Promise<T>, opts: WithAcpAgentOptions = {}): Promise<T> {
  // Real, reported bug found while chasing spurious failures here: this
  // spawn used to inherit the full parent environment, including whatever
  // real FINANFA_*/ANTHROPIC_API_KEY vars a dev shell exports for manual
  // testing against a real inference endpoint (see spawn-server.ts's own
  // comment on the exact same hazard, already guarded there) — with those
  // set, the subprocess silently talked to a REAL provider instead of this
  // test's local fake LLM server, producing unpredictable real model
  // behavior (different tool-call ids, different tool usage, real latency)
  // instead of the scripted responses every assertion here expects.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["FINANFA_PROVIDER", "FINANFA_BASE_URL", "FINANFA_MODEL", "FINANFA_API_KEY", "FINANFA_API_KEYS", "ANTHROPIC_API_KEY"]) delete env[k];

  const agentProcess: ChildProcessWithoutNullStreams = spawn("npx", ["tsx", "bin/finanfa.ts", "--acp", "--cwd", projectDir], {
    cwd: cliDir,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  }) as ChildProcessWithoutNullStreams;
  agentProcess.stderr.on("data", () => {}); // drained, not asserted on — real stderr noise (experimental warnings) is expected

  try {
    const input = Writable.toWeb(agentProcess.stdin);
    const output = Readable.toWeb(agentProcess.stdout);
    const stream = acp.ndJsonStream(input, output);

    return await acp
      .client({ name: "test-client" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        opts.onRequestPermission?.(ctx.params.toolCall.toolCallId);
        return Promise.resolve({ outcome: { outcome: "selected", optionId: ctx.params.options[0]!.optionId } });
      })
      .onRequest(acp.methods.client.fs.writeTextFile, () => Promise.resolve({}))
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => Promise.resolve(opts.fsReadTextFile?.(ctx.params) ?? { content: "" }))
      .onRequest(acp.methods.client.terminal.create, () => Promise.resolve({ terminalId: "term-1" }))
      .onRequest(acp.methods.client.terminal.output, () => Promise.resolve(opts.terminal?.output ?? { output: "", truncated: false }))
      .onRequest(acp.methods.client.terminal.waitForExit, () => Promise.resolve(opts.terminal?.waitForExit ?? { exitCode: 0 }))
      .onRequest(acp.methods.client.terminal.kill, () => Promise.resolve({}))
      .onRequest(acp.methods.client.terminal.release, () => Promise.resolve({}))
      .onNotification(acp.methods.client.session.update, (ctx) => {
        opts.onSessionUpdate?.(ctx.params);
      })
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
    ACP_TEST_TIMEOUT_MS,
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
      let permissionRequestToolCallId: string | undefined;

      const result = await withAcpAgent(
        projectDir,
        async (ctx) => {
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
        },
        {
          onRequestPermission: (toolCallId) => {
            permissionRequestToolCallId = toolCallId;
          },
        },
      );

      // The permission request's toolCallId must be the model's own real
      // tool_use id ("call1"), not a synthetic placeholder unrelated to it —
      // that's what lets an ACP client match this ask to the tool_call
      // notification for the same call.
      expect(permissionRequestToolCallId).toBe("call1");
      expect(result.toolCallIds).toContain("call1");
      expect(result.stopReason).toBe("end_turn");
      expect(result.toolCallIds).toEqual(["call1"]);
      expect(result.toolCallStatuses).toContain("completed");
      await rm(projectDir, { recursive: true, force: true });
    },
    ACP_TEST_TIMEOUT_MS,
  );

  it(
    "advertises session modes and auto-denies a tool call in plan mode without a permission request",
    async () => {
      projectDir = await freshProject();
      // Only 2 entries (not 3): a tool-call round trip here is exactly 2 real
      // HTTP requests — one that returns the tool_calls delta (a stream that
      // ends without an explicit finish_reason is still trusted whenever it
      // captured a tool call — see streamTurn's own comment on this in
      // openai-compatible-provider.ts) and one, after the tool call is
      // resolved (executed or, here, denied), that returns the model's next
      // reply. A 3rd scripted entry would only ever be reached by the
      // separate, unawaited maybeGenerateTitle call (see acp.ts's own
      // session/prompt handler), which ignores its response content anyway.
      scriptedResponses = [
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call1", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }] } }],
        }),
        JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      ];
      requestCount = 0;
      let permissionRequested = false;

      const result = await withAcpAgent(
        projectDir,
        async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
          return ctx.buildSession(projectDir).withSession(async (session) => {
            const modes = session.modes;
            expect(modes?.currentModeId).toBe("default");
            expect(modes?.availableModes.map((m) => m.id).sort()).toEqual(["default", "plan"]);

            await ctx.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId: "plan" });

            session.prompt("run echo hi");
            let sawToolCall = false;
            const agentChunks: string[] = [];
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") return { stopReason: message.response.stopReason, sawToolCall, agentText: agentChunks.join("") };
              const update = message.notification.update;
              if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") sawToolCall = true;
              if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") agentChunks.push(update.content.text);
            }
          });
        },
        { onRequestPermission: () => (permissionRequested = true) },
      );

      // Plan mode denies a non-safe tool call before loop.ts ever announces
      // it to the UI at all (see runOneToolCall in loop.ts: the plan-mode
      // check returns early, well before its ui.writeToolCall/writeToolResult
      // calls) — so the only observable evidence of the denial from the ACP
      // side is that the model's next reply reflects a tool result it never
      // got real output from, with no permission request and no tool_call
      // notification in between.
      expect(permissionRequested).toBe(false);
      expect(result.sawToolCall).toBe(false);
      expect(result.agentText).toBe("done");
      expect(result.stopReason).toBe("end_turn");
      await rm(projectDir, { recursive: true, force: true });
    },
    ACP_TEST_TIMEOUT_MS,
  );

  it(
    "connects a per-session MCP server supplied via session/new and calls its tool",
    async () => {
      projectDir = await freshProject();
      scriptedResponses = [
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call1", function: { name: "mcp__echo__echo", arguments: JSON.stringify({ text: "hi there" }) } }],
              },
            },
          ],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      ];
      requestCount = 0;

      const result = await withAcpAgent(projectDir, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        return ctx
          .buildSession({ cwd: projectDir, mcpServers: [{ name: "echo", command: process.execPath, args: [echoMcpFixture], env: [] }] })
          .withSession(async (session) => {
            session.prompt("echo hi there");
            const toolCallUpdates: string[] = [];
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") return { stopReason: message.response.stopReason, toolCallUpdates };
              const update = message.notification.update;
              if (update.sessionUpdate === "tool_call_update") {
                const text = update.content?.[0]?.type === "content" && update.content[0].content.type === "text" ? update.content[0].content.text : "";
                toolCallUpdates.push(text);
              }
            }
          });
      });

      expect(result.stopReason).toBe("end_turn");
      expect(result.toolCallUpdates).toContain("echo: hi there");
      await rm(projectDir, { recursive: true, force: true });
    },
    ACP_TEST_TIMEOUT_MS,
  );

  it(
    "routes read_file through the client's fs/read_text_file when the client advertises that capability",
    async () => {
      projectDir = await freshProject();
      scriptedResponses = [
        JSON.stringify({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: "call1", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) } }] } },
          ],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      ];
      requestCount = 0;
      let readRequestPath: string | undefined;

      const result = await withAcpAgent(
        projectDir,
        async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          });
          return ctx.buildSession(projectDir).withSession(async (session) => {
            session.prompt("read notes.txt");
            const toolCallUpdates: string[] = [];
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") return { stopReason: message.response.stopReason, toolCallUpdates };
              const update = message.notification.update;
              if (update.sessionUpdate === "tool_call_update") {
                const text = update.content?.[0]?.type === "content" && update.content[0].content.type === "text" ? update.content[0].content.text : "";
                toolCallUpdates.push(text);
              }
            }
          });
        },
        {
          fsReadTextFile: (params) => {
            readRequestPath = params.path;
            return { content: "hello from the client's own filesystem" };
          },
        },
      );

      // notes.txt is never created on disk in projectDir at all — the only
      // way this content can show up is if read_file actually went through
      // fs/read_text_file instead of this process's own filesystem.
      expect(readRequestPath).toBe(path.join(projectDir, "notes.txt"));
      expect(result.toolCallUpdates.some((u) => u.includes("hello from the client's own filesystem"))).toBe(true);
      expect(result.stopReason).toBe("end_turn");
      await rm(projectDir, { recursive: true, force: true });
    },
    ACP_TEST_TIMEOUT_MS,
  );

  it(
    "routes bash through the client's terminal/* methods when the client advertises the terminal capability",
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

      const result = await withAcpAgent(
        projectDir,
        async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { terminal: true } });
          return ctx.buildSession(projectDir).withSession(async (session) => {
            session.prompt("run echo hi");
            const toolCallUpdates: string[] = [];
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") return { stopReason: message.response.stopReason, toolCallUpdates };
              const update = message.notification.update;
              if (update.sessionUpdate === "tool_call_update") {
                const text = update.content?.[0]?.type === "content" && update.content[0].content.type === "text" ? update.content[0].content.text : "";
                toolCallUpdates.push(text);
              }
            }
          });
        },
        { terminal: { output: { output: "output from the client's own terminal\n", truncated: false }, waitForExit: { exitCode: 0 } } },
      );

      // This process's own shell never ran "echo hi" at all — the only way
      // this exact string can show up is if bash actually went through
      // terminal/create + terminal/output instead of a local subprocess.
      expect(result.toolCallUpdates.some((u) => u.includes("output from the client's own terminal"))).toBe(true);
      expect(result.stopReason).toBe("end_turn");
      await rm(projectDir, { recursive: true, force: true });
    },
    ACP_TEST_TIMEOUT_MS,
  );

  it(
    "replays a resumed session's history via session/load",
    async () => {
      projectDir = await freshProject();
      scriptedResponses = [
        JSON.stringify({ choices: [{ delta: { content: "PONG" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      ];
      requestCount = 0;

      const sessionId = await withAcpAgent(projectDir, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        return ctx.buildSession(projectDir).withSession(async (session) => {
          session.prompt("say something");
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") return session.sessionId;
          }
        });
      });

      // Sanity: the session really did get persisted to disk under this
      // project's own session directory (~/.finanfa-code/sessions/<hash>/),
      // same real file resume()/session/load both read from.
      const projectHash = createHash("sha256").update(projectDir).digest("hex").slice(0, 12);
      const sessionFile = path.join(homedir(), ".finanfa-code", "sessions", projectHash, `${sessionId}.json`);
      const persisted = JSON.parse(await readFile(sessionFile, "utf-8"));
      expect(persisted.messages.length).toBeGreaterThan(0);

      const updates: acp.SessionUpdate[] = [];
      const response = await withAcpAgent(
        projectDir,
        async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
          const loadResponse = await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: projectDir, mcpServers: [] });
          // session/load's replayed session/update notifications are written
          // to the stream before its response, but nothing here guarantees
          // this test's onNotification handler has actually been dispatched
          // by the time the request promise resolves (real ACP clients keep
          // reading indefinitely; this harness tears the connection down as
          // soon as `run` returns) — give the already-buffered notifications
          // a moment to be processed before doing that.
          await new Promise((resolve) => setTimeout(resolve, 200));
          return loadResponse;
        },
        { onSessionUpdate: (n) => updates.push(n.update) },
      );

      expect(response.modes?.currentModeId).toBe("default");
      const userChunks = updates.filter((u) => u.sessionUpdate === "user_message_chunk");
      const agentChunks = updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
      expect(userChunks.some((u) => u.content.type === "text" && u.content.text.includes("say something"))).toBe(true);
      expect(agentChunks.some((u) => u.content.type === "text" && u.content.text.includes("PONG"))).toBe(true);

      await rm(projectDir, { recursive: true, force: true });
    },
    ACP_TEST_TIMEOUT_MS,
  );
});
