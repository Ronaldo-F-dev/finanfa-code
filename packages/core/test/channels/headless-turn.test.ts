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
  let replyText: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastRequestBody = JSON.parse(raw);
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
});
