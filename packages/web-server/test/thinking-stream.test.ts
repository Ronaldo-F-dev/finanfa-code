import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import WebSocket from "ws";
import { createTempProject, spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the "thinking_delta" WS event: a real local server
// speaks Anthropic's Messages SSE protocol (an extended-thinking block first,
// then a text block), and a real `ws` client observes the streamed reasoning
// the web UI renders — the browser received none of it before, since no
// WebSocket adapter implemented UIAdapter.writeThinkingDelta. Bootstrapping
// goes through the shared spawn/createTempProject support module (never a
// copied per-file harness), and waiting uses vitest's own vi.waitFor.
function fakeAnthropicServer(): { server: http.Server; baseUrl: Promise<string> } {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        {
          type: "message_start",
          message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } },
        },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me reason " } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "about this." } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "The answer is 4." } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } },
        { type: "message_stop" },
      ];
      for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  const baseUrl = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  return { server, baseUrl };
}

interface WsEvent {
  type: string;
  text?: string;
}

describe("extended thinking streams to the web client as a thinking_delta event (real subprocess, real WebSocket, real Anthropic SDK)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let fake: ReturnType<typeof fakeAnthropicServer>;

  beforeAll(async () => {
    ({ projectDir, homeDir } = await createTempProject("thinking", {
      provider: "anthropic",
      apiKey: "test-key",
      model: "claude-test",
      thinkingBudgetTokens: 2048,
    }));
    fake = fakeAnthropicServer();
    ({ child, port } = await spawnWebServer(projectDir, homeDir, { ANTHROPIC_BASE_URL: await fake.baseUrl }));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    fake?.server.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it(
    "streams the reasoning chunks before the reply, in order",
    async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const events: WsEvent[] = [];
      // Subscribed before awaiting "open" — the server can send session_info
      // as soon as the connection handler is ready, and a listener attached
      // only after the open event would miss it (no replay on a raw client).
      ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "session_info")).toBe(true), { timeout: 30_000 });

      ws.send(JSON.stringify({ type: "user_message", text: "what is 2+2?" }));
      await vi.waitFor(() => expect(events.some((e) => e.type === "assistant_end")).toBe(true), { timeout: 30_000 });

      const thinking = events.filter((e) => e.type === "thinking_delta").map((e) => e.text ?? "").join("");
      const reply = events.filter((e) => e.type === "assistant_delta").map((e) => e.text ?? "").join("");
      expect(thinking).toBe("Let me reason about this.");
      expect(reply).toBe("The answer is 4.");

      // Thinking always streams first (the model reasons, then answers) — the
      // UI relies on this ordering to place the block above the reply.
      const firstThinking = events.findIndex((e) => e.type === "thinking_delta");
      const firstReply = events.findIndex((e) => e.type === "assistant_delta");
      expect(firstThinking).toBeGreaterThanOrEqual(0);
      expect(firstThinking).toBeLessThan(firstReply);

      ws.close();
    },
    60_000,
  );
});
