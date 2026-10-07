import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real, reported failure: the configured default model is a local one with a launch command (config.localServices),
// but nothing started it, so the first message ended in "the model call failed: fetch failed". The server now starts
// it before the first request, and an unreachable server is explained instead of reported as a bare "fetch failed".

interface WsEvent {
  type: string;
  [key: string]: unknown;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(events: WsEvent[], predicate: (e: WsEvent) => boolean, timeoutMs = 20_000): Promise<WsEvent> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for event; saw: ${events.map((e) => e.type).join(", ")}`);
}

async function connect(port: number): Promise<{ ws: WebSocket; events: WsEvent[] }> {
  const events: WsEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
  await waitFor(events, (e) => e.type === "session_info");
  return { ws, events };
}

const FAKE_MODEL_SERVER = `
const http = require("node:http");
http.createServer((req, res) => {
  if (req.url.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fake" }] })); return; }
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: "pong" }, finish_reason: null }] }) + '\\n\\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) + '\\n\\n');
    res.end("data: [DONE]\\n\\n");
  });
}).listen(Number(process.argv[2]), "127.0.0.1");
`;

describe("web-server: a local model that is not running yet", () => {
  const dirs: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];

  async function startServerWith(config: object): Promise<number> {
    const projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-localmodel-project-"));
    const homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-localmodel-home-"));
    dirs.push(projectDir, homeDir);
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(path.join(projectDir, ".finanfa-code", "config.json"), JSON.stringify(config));
    const { child, port } = await spawnWebServer(projectDir, homeDir);
    children.push(child);
    return port;
  }

  afterAll(async () => {
    for (const child of children) killWebServer(child);
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it("starts it from config.localServices before the first message, then answers", async () => {
    const modelPort = await freePort();
    const scriptDir = await mkdtemp(path.join(tmpdir(), "finanfa-fake-model-"));
    dirs.push(scriptDir);
    const script = path.join(scriptDir, "server.cjs");
    await writeFile(script, FAKE_MODEL_SERVER);
    const baseUrl = `http://127.0.0.1:${modelPort}/v1`;
    const port = await startServerWith({
      provider: "openai-compatible",
      baseUrl,
      model: "fake",
      localServices: { fake: { command: process.execPath, args: [script, String(modelPort)], healthUrl: `${baseUrl}/models`, readyTimeoutMs: 15_000 } },
    });
    const { ws, events } = await connect(port);
    ws.send(JSON.stringify({ type: "user_message", text: "hi" }));
    await waitFor(events, (e) => e.type === "assistant_end", 30_000);
    expect(events.some((e) => e.type === "system" && String(e.text).includes("the model call failed"))).toBe(false);
    ws.close();
  }, 60_000);

  it("explains an unreachable server instead of a bare 'fetch failed'", async () => {
    const closedPort = await freePort();
    const port = await startServerWith({ provider: "openai-compatible", baseUrl: `http://127.0.0.1:${closedPort}/v1`, model: "fake" });
    const { ws, events } = await connect(port);
    ws.send(JSON.stringify({ type: "user_message", text: "hi" }));
    const failure = await waitFor(events, (e) => e.type === "system" && String(e.text).includes("the model call failed"), 30_000);
    expect(String(failure.text)).toContain("nothing answers");
    expect(String(failure.text)).toContain(String(closedPort));
    ws.close();
  }, 60_000);
});
