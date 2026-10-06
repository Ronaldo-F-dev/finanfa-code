import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type WebSocket from "ws";
import { killWebServer, spawnWebServer } from "./support/spawn-server.js";
import { connectWebSocket, type WsEvent } from "./support/ws-harness.js";

// "Restore to before this message": a real server, a real WebSocket, a scripted model that creates one file
// per user message. Rewinding must delete the files later turns created and cut the conversation back.

interface Call {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Answers by what the request contains, not by how many came before (the server also makes unrelated calls, such as the
 * title generator, which would throw a counter off): a request that ends with a user message gets the next scripted tool
 * call; one that ends with a tool result, or any other call, gets a plain "done".
 */
function scriptedModel(calls: Call[]) {
  let next = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const messages = (JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> }).messages;
      const isTitleRequest = messages.some((m) => m.role === "system" && String(m.content).includes("short title"));
      const endsWithUser = messages.at(-1)?.role === "user";
      const call = !isTitleRequest && endsWithUser ? calls[next++] : undefined;
      const events = call
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${next}`, function: { name: call.name, arguments: JSON.stringify(call.input) } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
          ]
        : [{ choices: [{ delta: { content: isTitleRequest ? "A title" : "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }];
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const baseUrl = new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)));
  return { server, baseUrl };
}

function waitFor(events: WsEvent[], predicate: (e: WsEvent) => boolean, timeoutMs = 30_000): Promise<WsEvent> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for event: ${JSON.stringify(events.map((e) => e.type))}`));
      setTimeout(check, 50);
    };
    check();
  });
}

const exists = (p: string) => stat(p).then(() => true, () => false);

describe("rewinding to an earlier message (real subprocess, real WebSocket, scripted model)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let model: ReturnType<typeof scriptedModel>;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-rewind-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-rewind-home-"));
    model = scriptedModel([
      { name: "write_file", input: { path: "first.txt", content: "one\n" } },
      { name: "write_file", input: { path: "second.txt", content: "two\n" } },
      { name: "write_file", input: { path: "third.txt", content: "three\n" } },
    ]);
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: await model.baseUrl, model: "fake-model", apiKey: "test-key" }),
    );
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    model.server.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  /** Sends a message, approves its file write, and waits until the turn is over and its checkpoints arrive. */
  async function sendAndApprove(ws: WebSocket, events: WsEvent[], text: string, clientId: string): Promise<void> {
    const seen = events.length;
    ws.send(JSON.stringify({ type: "user_message", text, clientId }));
    const ask = await waitFor(events, (e) => e.type === "ask" && events.indexOf(e) >= seen);
    ws.send(JSON.stringify({ type: "permission_response", requestId: ask.requestId, answer: "y" }));
    await waitFor(events, (e) => e.type === "checkpoints" && events.indexOf(e) >= seen);
  }

  it("records a checkpoint per message, tied to the id the browser gave it", async () => {
    const { ws, events } = await connectWebSocket(port);
    await waitFor(events, (e) => e.type === "session_info");
    await sendAndApprove(ws, events, "make the first file", "msg-A");
    await sendAndApprove(ws, events, "make the second file", "msg-B");

    const latest = [...events].reverse().find((e) => e.type === "checkpoints")!;
    expect(latest.checkpoints).toEqual([
      { number: 1, preview: "make the first file", clientId: "msg-A" },
      { number: 2, preview: "make the second file", clientId: "msg-B" },
    ]);
    expect(await exists(path.join(projectDir, "first.txt"))).toBe(true);
    expect(await exists(path.join(projectDir, "second.txt"))).toBe(true);

    // 1) a stale or invalid number is refused and changes nothing
    ws.send(JSON.stringify({ type: "rewind", checkpoint: 99 }));
    const refusal = await waitFor(events, (e) => e.type === "error" && String(e.text).includes("no longer exists"));
    expect(refusal).toBeDefined();
    expect(await exists(path.join(projectDir, "second.txt"))).toBe(true);

    // 2) rewinding to the second message removes only what it created
    const before = events.length;
    ws.send(JSON.stringify({ type: "rewind", checkpoint: 2 }));
    const rewound = await waitFor(events, (e) => e.type === "rewound" && events.indexOf(e) >= before);
    expect(rewound).toMatchObject({ checkpoint: 2, preview: "make the second file", revertedFiles: 1 });
    expect(await exists(path.join(projectDir, "second.txt"))).toBe(false);
    expect(await readFile(path.join(projectDir, "first.txt"), "utf-8")).toBe("one\n");
    const afterRewind = (await waitFor(events, (e) => e.type === "checkpoints" && events.indexOf(e) > events.indexOf(rewound))) as WsEvent;
    expect(afterRewind.checkpoints).toEqual([{ number: 1, preview: "make the first file", clientId: "msg-A" }]);

    // 3) ...and to the first message removes the rest
    const before2 = events.length;
    ws.send(JSON.stringify({ type: "rewind", checkpoint: 1 }));
    await waitFor(events, (e) => e.type === "rewound" && events.indexOf(e) >= before2);
    expect(await exists(path.join(projectDir, "first.txt"))).toBe(false);
    ws.close();
  }, 90_000);

  it("refuses to rewind while a turn is still running, and the turn carries on untouched", async () => {
    const { ws, events } = await connectWebSocket(port);
    await waitFor(events, (e) => e.type === "session_info");
    ws.send(JSON.stringify({ type: "user_message", text: "another file", clientId: "msg-C" }));
    const ask = await waitFor(events, (e) => e.type === "ask");
    // the turn is parked on this approval: it is in flight
    ws.send(JSON.stringify({ type: "rewind", checkpoint: 1 }));
    await waitFor(events, (e) => e.type === "error" && String(e.text).includes("A turn is in progress"));
    ws.send(JSON.stringify({ type: "permission_response", requestId: ask.requestId, answer: "n" }));
    await waitFor(events, (e) => e.type === "checkpoints");
    expect(events.some((e) => e.type === "rewound")).toBe(false);
    ws.close();
  }, 60_000);
});
