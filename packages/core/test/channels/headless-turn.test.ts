import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHeadlessTurn } from "../../src/channels/headless-turn.js";
import { sessionDir } from "../../src/core/session.js";

// Real end-to-end test: a real local HTTP server speaking the OpenAI
// chat-completions SSE format (same as azure-openai-provider.test.ts),
// a real temp project directory, and a real session file written to
// disk — the only thing not real is the model itself. Confirms
// runHeadlessTurn (the shared piece an inbound channel like Slack calls
// per message) actually runs a full turn and persists context for the
// next message in the same "conversation" (see the second test below).

// This real dev shell exports these for manual testing against a real
// inference endpoint — must be cleared before AND after every test here,
// same reasoning as app-select-provider-azure.test.ts.
const ENV_KEYS = ["FINANFA_PROVIDER", "FINANFA_BASE_URL", "FINANFA_MODEL", "FINANFA_API_KEY", "ANTHROPIC_API_KEY"] as const;

describe("runHeadlessTurn (real local HTTP server, real project directory, real session file)", () => {
  let projectDir: string;
  let homeDir: string;
  let originalHome: string | undefined;
  let server: http.Server;
  let baseUrl: string;
  let lastRequestBody: { messages: { role: string; content: unknown }[] } | undefined;
  let requestBodies: { messages: { role: string; content: unknown }[] }[];
  let replyText: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as { messages: { role: string; content: unknown }[] };
        lastRequestBody = body;
        requestBodies.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`);
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

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-headless-turn-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-headless-turn-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.FINANFA_PROVIDER = "openai-compatible";
    process.env.FINANFA_BASE_URL = baseUrl;
    process.env.FINANFA_MODEL = "test-model";
    replyText = "Hello from the fake model.";
    requestBodies = [];
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    for (const k of ENV_KEYS) delete process.env[k];
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("runs a real turn against the configured provider and returns its reply text", async () => {
    const result = await runHeadlessTurn(projectDir, "slack-C123-1700000000.000001", "hi there");
    expect(result.replyText).toBe("Hello from the fake model.");
    expect(lastRequestBody?.messages.some((m) => m.role === "user" && m.content === "hi there")).toBe(true);
  });

  it("forwards an image through to the provider request, for an inbound channel attachment", async () => {
    const sessionId = "slack-C123-1700000000.000002";
    await runHeadlessTurn(projectDir, sessionId, "what's in this picture?", [{ mimeType: "image/png", base64: "ZmFrZS1wbmctYnl0ZXM=" }]);

    // The image is deliberately stripped from the *persisted* message right
    // after this one call (see consumeImageMessage in loop.ts — it's not
    // resent every later turn), so the real signal that it was actually
    // used is the request the fake model server received, not the saved
    // session file.
    const userMessagePart = requestBodies[0]?.messages.find((m) => m.role === "user");
    expect(JSON.stringify(userMessagePart?.content)).toContain("ZmFrZS1wbmctYnl0ZXM=");
  });

  it("persists the session under a stable id, so a second message in the same thread carries context forward", async () => {
    const sessionId = "slack-C123-1700000000.000001";
    await runHeadlessTurn(projectDir, sessionId, "first message");

    replyText = "second reply";
    await runHeadlessTurn(projectDir, sessionId, "second message");

    const file = await readFile(path.join(sessionDir(projectDir), `${sessionId}.json`), "utf-8");
    const saved = JSON.parse(file) as { id: string; messages: { role: string; content: unknown }[] };
    expect(saved.id).toBe(sessionId);
    // 2 user + 2 assistant messages from both calls, all in the one persisted session.
    expect(saved.messages.filter((m) => m.role === "user")).toHaveLength(2);
    expect(saved.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  // Real, reported bug: a channel user (Telegram in the real report) got
  // total silence instead of a reply when the turn failed — indistinguishable
  // from the bot being down. runTurn catches its own provider errors
  // internally and calls ui.writeSystem with a real, actionable message
  // (see loop.ts's own error branches) instead of throwing, so
  // runHeadlessTurn never threw either; writeSystem/writeError being no-ops
  // here meant that message vanished and replyText came back empty, which
  // every real channel handler (see channels-telegram.ts) then reads as
  // "nothing to post" and silently returns.
  it("surfaces a failed turn's error message as real reply text instead of silence", async () => {
    server.close();
    const failingServer = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    await new Promise<void>((resolve) => failingServer.listen(0, "127.0.0.1", resolve));
    process.env.FINANFA_BASE_URL = `http://127.0.0.1:${(failingServer.address() as AddressInfo).port}`;

    try {
      const result = await runHeadlessTurn(projectDir, "slack-C123-error-case", "hi there");
      expect(result.replyText.trim()).not.toBe("");
      expect(result.replyText).toContain("the model call failed");
    } finally {
      failingServer.close();
      // Restore the shared fake server other tests in this file depend on.
      server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const body = JSON.parse(raw) as { messages: { role: string; content: unknown }[] };
          lastRequestBody = body;
          requestBodies.push(body);
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      process.env.FINANFA_BASE_URL = baseUrl;
    }
  });
});
