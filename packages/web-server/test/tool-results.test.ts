import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the "tool_result" WS event (see web-ui-adapter.ts's
// writeToolResult and loop.ts's call right after runOneToolCall): a real local
// HTTP server plays the OpenAI-compatible chat-completions SSE protocol,
// scripted to call the real read_file tool, and a real `ws` client observes
// the structured call/result pair the web UI renders as an expandable IN/OUT
// block — the same thing the VS Code extension already shows (see
// vscode-ui-adapter.ts's writeToolResult), just missing on this transport
// until now. Same harness shape as todos-board.test.ts.
function sseServer(toolCallOnce: { name: string; input: Record<string, unknown> }): { server: http.Server; baseUrl: Promise<string> } {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const isToolCallTurn = requestCount % 2 === 0;
      requestCount++;
      const events = isToolCallTurn
        ? [
            JSON.stringify({
              choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: toolCallOnce.name, arguments: JSON.stringify(toolCallOnce.input) } }] } }],
            }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
          ]
        : [
            JSON.stringify({ choices: [{ delta: { content: "done" } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
          ];
      for (const e of events) res.write(`data: ${e}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const baseUrl = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`));
  });
  return { server, baseUrl };
}

interface WsEvent {
  type: string;
  [key: string]: unknown;
}

function waitFor(events: WsEvent[], predicate: (e: WsEvent) => boolean, timeoutMs = 30_000): Promise<WsEvent> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for event: ${JSON.stringify(events)}`));
      setTimeout(check, 50);
    };
    check();
  });
}

async function connect(port: number): Promise<{ ws: WebSocket; events: WsEvent[] }> {
  const events: WsEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  // Subscribed before awaiting "open", not after: the server sends
  // session_info as soon as the connection handler finishes its setup, and
  // a listener attached only once the client observes "open" can miss it
  // entirely (no message replay on a plain ws client) — same class of race
  // the server's own early permission_response listener documents in
  // index.ts. 30s, not 10s: this waits on a real subprocess's full
  // buildTurnContext (config, ~180 tool registrations, skills/memory
  // load) on a loaded machine, not a mocked function.
  ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  await waitFor(events, (e) => e.type === "session_info", 30_000);
  return { ws, events };
}

describe("a finished tool call pushes a structured 'tool_result' WS event correlated by toolCallId (real subprocess, real WebSocket, real SSE provider)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let sse: ReturnType<typeof sseServer>;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-tool-results-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-tool-results-home-"));
    await writeFile(path.join(projectDir, "hello.txt"), "hello world\n");

    sse = sseServer({ name: "read_file", input: { path: "hello.txt" } });
    const baseUrl = await sse.baseUrl;

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl, model: "fake-model", apiKey: "test-key" }),
    );

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    sse?.server.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it(
    "sends the tool call, then its real result with the same toolCallId and the read file's contents",
    async () => {
      const { ws, events } = await connect(port);
      ws.send(JSON.stringify({ type: "user_message", text: "read hello.txt" }));

      const call = await waitFor(events, (e) => e.type === "tool_call");
      expect(call.toolName).toBe("read_file");
      expect(typeof call.toolCallId).toBe("string");

      const result = await waitFor(events, (e) => e.type === "tool_result");
      expect(result.toolCallId).toBe(call.toolCallId);
      expect(result.toolName).toBe("read_file");
      expect(result.isError).toBe(false);
      expect(result.content).toContain("hello world");
      // The call must be announced before its result — the UI relies on the
      // block already existing when it attaches the result to it.
      expect(events.indexOf(call)).toBeLessThan(events.indexOf(result));

      ws.close();
    },
    45_000,
  );
});
