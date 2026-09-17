import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the LINE inbound channel — same shape as
// channels-telegram.test.ts: the real web-server subprocess, a real fake
// LLM server, and a real fake LINE Messaging API server capturing the
// outgoing push call.

const CHANNEL_SECRET = "test-channel-secret";

function sign(body: string): string {
  return createHmac("sha256", CHANNEL_SECRET).update(body).digest("base64");
}

function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function postLineWebhook(port: number, payload: unknown, signature?: string): Promise<{ status: number }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json", "x-line-signature": signature ?? sign(body) };
  const res = await fetch(`http://127.0.0.1:${port}/api/channels/line/webhook`, { method: "POST", headers, body });
  return { status: res.status };
}

describe("web-server LINE inbound channel (real subprocess, real fake LLM + LINE API servers)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  let llmServer: http.Server;
  let llmBaseUrl: string;
  let replyText: string;

  let lineApiServer: http.Server;
  let lineApiBaseUrl: string;
  let sentMessages: { url: string; authHeader: string | undefined; body: { to: string; messages: { type: string; text: string }[] } }[];

  beforeAll(async () => {
    llmServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    llmBaseUrl = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}`;

    lineApiServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        sentMessages.push({ url: req.url ?? "", authHeader: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => lineApiServer.listen(0, "127.0.0.1", resolve));
    lineApiBaseUrl = `http://127.0.0.1:${(lineApiServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-line-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-line-home-"));

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.LINE_CHANNEL_SECRET = CHANNEL_SECRET;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-access-token";
    process.env.LINE_API_BASE_URL = lineApiBaseUrl;
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    lineApiServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    for (const k of ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_API_BASE_URL"]) delete process.env[k];
  });

  it("rejects a request with an invalid signature", async () => {
    const { status } = await postLineWebhook(port, { events: [] }, "invalid-signature");
    expect(status).toBe(401);
  });

  it(
    "runs a real turn for an inbound message and pushes the reply to the right target",
    async () => {
      sentMessages = [];
      replyText = "hello from the agent";

      const { status } = await postLineWebhook(port, {
        events: [{ type: "message", webhookEventId: "e1", source: { type: "user", userId: "U555" }, message: { type: "text", text: "hi there" } }],
      });
      expect(status).toBe(200);

      await waitFor(() => sentMessages.length > 0, 20_000);
      expect(sentMessages[0]!.url).toBe("/v2/bot/message/push");
      expect(sentMessages[0]!.authHeader).toBe("Bearer test-access-token");
      expect(sentMessages[0]!.body).toEqual({ to: "U555", messages: [{ type: "text", text: "hello from the agent" }] });
    },
    30_000,
  );

  it("ignores a redelivery of the same webhookEventId — no second turn, no duplicate reply", async () => {
    sentMessages = [];
    replyText = "second reply that should never be sent";

    const { status } = await postLineWebhook(port, {
      events: [{ type: "message", webhookEventId: "e1", source: { type: "user", userId: "U555" }, message: { type: "text", text: "hi there" } }],
    });
    expect(status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentMessages).toHaveLength(0);
  });
});

describe("web-server LINE inbound channel — not configured", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-line-unconfigured-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-line-unconfigured-home-"));
    for (const k of ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN"]) delete process.env[k];
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("404s instead of silently accepting unverifiable requests when LINE_CHANNEL_SECRET isn't set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/line/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(404);
  });
});
