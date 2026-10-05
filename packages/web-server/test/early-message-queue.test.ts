import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import WebSocket from "ws";
import { createTempProject, spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the early-message queue: a client that sends its
// first user_message the instant the socket opens (before the server's
// session_info, while buildTurnContext is still running) used to have that
// message silently dropped — the main ws.on("message") handler only exists
// once setup finishes. Reproduced here by deliberately NOT waiting for
// session_info before sending. Bootstrapping uses the shared
// spawn/createTempProject support module; waiting uses vitest's vi.waitFor.
function fakeLlmServer(): { server: http.Server; baseUrl: Promise<string> } {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "pong" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
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
  text?: string;
}

describe("a message sent before the server finished starting is queued, not dropped (real subprocess, real WebSocket)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let fake: ReturnType<typeof fakeLlmServer>;

  beforeAll(async () => {
    fake = fakeLlmServer();
    ({ projectDir, homeDir } = await createTempProject("early-msg", {
      provider: "openai-compatible",
      baseUrl: await fake.baseUrl,
      model: "fake-model",
      apiKey: "test-key",
    }));
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    fake?.server.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it(
    "answers a user_message sent immediately on open, without waiting for session_info",
    async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const events: WsEvent[] = [];
      ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });

      // The whole point: sent right now, before any server event has arrived.
      ws.send(JSON.stringify({ type: "user_message", text: "ping" }));

      await vi.waitFor(() => expect(events.some((e) => e.type === "assistant_end")).toBe(true), { timeout: 30_000 });
      const reply = events.filter((e) => e.type === "assistant_delta").map((e) => e.text ?? "").join("");
      expect(reply).toBe("pong");

      ws.close();
    },
    60_000,
  );
});
