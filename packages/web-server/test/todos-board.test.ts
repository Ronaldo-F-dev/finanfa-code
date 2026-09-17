import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the "todos" WS event (see web-ui-adapter.ts's
// writeTodos and todo-write.ts's ctx.ui?.writeTodos?.(...) call): a real
// local HTTP server plays the OpenAI-compatible chat-completions SSE
// protocol, scripted to call the real todo_write tool, and a real `ws`
// client observes the structured event the web UI's TodoPanel renders —
// same harness shape as trust-and-hooks.test.ts.
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

function waitFor(events: WsEvent[], predicate: (e: WsEvent) => boolean, timeoutMs = 10_000): Promise<WsEvent> {
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

async function connect(port: number, query = ""): Promise<{ ws: WebSocket; events: WsEvent[] }> {
  const events: WsEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
  await waitFor(events, (e) => e.type === "session_info");
  return { ws, events };
}

describe("todo_write pushes a structured 'todos' WS event, replayed on reconnect (real subprocess, real WebSocket, real SSE provider)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let sse: ReturnType<typeof sseServer>;

  const todos = [
    { content: "Write the plan", status: "completed" },
    { content: "Implement it", status: "in_progress" },
    { content: "Ship it", status: "pending" },
  ];

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-todos-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-todos-home-"));

    sse = sseServer({ name: "todo_write", input: { todos } });
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
    "sends a structured todos event with the real checklist, and replays it to a reconnecting client",
    async () => {
      const { ws, events } = await connect(port);
      ws.send(JSON.stringify({ type: "user_message", text: "plan it" }));
      const todosEvent = await waitFor(events, (e) => e.type === "todos");
      expect(todosEvent.todos).toEqual(todos);

      const sessionInfo = events.find((e) => e.type === "session_info")!;
      const sessionId = sessionInfo.id as string;
      ws.close();

      // A second connection to the same still-running session (a browser
      // reload) should see the board as it currently stands, without
      // sending anything new.
      const { events: resumedEvents, ws: resumedWs } = await connect(port, `?session=${sessionId}`);
      const replayed = await waitFor(resumedEvents, (e) => e.type === "todos");
      expect(replayed.todos).toEqual(todos);
      resumedWs.close();
    },
    15_000,
  );
});
