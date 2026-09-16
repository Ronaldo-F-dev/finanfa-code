import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the Slack inbound channel: the real web-server
// subprocess, a real HTTP POST carrying a genuinely computed Slack
// signature, a real local HTTP server standing in for the LLM backend,
// and another standing in for Slack's own chat.postMessage API — the
// only things not real are Slack and the model itself.

const SIGNING_SECRET = "test-signing-secret";

function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

async function postSignedSlackEvent(port: number, payload: unknown): Promise<{ status: number; body: string }> {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = slackSignature(SIGNING_SECRET, timestamp, rawBody);

  const res = await fetch(`http://127.0.0.1:${port}/api/channels/slack/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature,
    },
    body: rawBody,
  });
  return { status: res.status, body: await res.text() };
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

describe("web-server Slack inbound channel (real subprocess, real signed HTTP request, real fake LLM + Slack API servers)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  let llmServer: http.Server;
  let llmBaseUrl: string;
  let replyText: string;
  let llmRequestBodies: { messages: { role: string; content: unknown }[] }[];

  let slackApiServer: http.Server;
  let slackApiBaseUrl: string;
  let postedMessages: { channel: string; text: string; thread_ts?: string }[];
  let lastFileDownloadAuthHeader: string | undefined;

  beforeAll(async () => {
    llmServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        llmRequestBodies.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    llmBaseUrl = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}`;

    slackApiServer = http.createServer((req, res) => {
      if (req.url === "/files/f1.png") {
        lastFileDownloadAuthHeader = req.headers.authorization;
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from("fake png bytes"));
        return;
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        postedMessages.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ts: "1700000009.000009" }));
      });
    });
    await new Promise<void>((resolve) => slackApiServer.listen(0, "127.0.0.1", resolve));
    slackApiBaseUrl = `http://127.0.0.1:${(slackApiServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-slack-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-slack-home-"));

    // spawnWebServer strips FINANFA_PROVIDER/BASE_URL/MODEL from the
    // child's env unconditionally (see its own comment — clearing a real
    // dev-shell's exports), so the provider has to be pointed at the fake
    // LLM server via project config instead, same as auto-continue.test.ts.
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_API_BASE_URL = slackApiBaseUrl;

    ({ child, port } = await spawnWebServer(projectDir, homeDir, 4980));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    slackApiServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    for (const k of ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "SLACK_API_BASE_URL"]) {
      delete process.env[k];
    }
  });

  it("answers Slack's url_verification handshake by echoing the challenge", async () => {
    const { status, body } = await postSignedSlackEvent(port, { type: "url_verification", challenge: "abc123" });
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ challenge: "abc123" });
  });

  it("rejects a request with an invalid signature", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "x" });
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/slack/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Slack-Request-Timestamp": String(Math.floor(Date.now() / 1000)), "X-Slack-Signature": "v0=deadbeef" },
      body: rawBody,
    });
    expect(res.status).toBe(401);
  });

  it(
    "runs a real turn for an inbound message and posts the reply back to the right thread",
    async () => {
      postedMessages = [];
      llmRequestBodies = [];
      replyText = "hello from the agent";

      const { status } = await postSignedSlackEvent(port, {
        type: "event_callback",
        event: { type: "message", channel: "C123", ts: "1700000000.000001", text: "hi there", user: "U1" },
      });
      expect(status).toBe(200); // acked immediately, before the turn even runs

      await waitFor(() => postedMessages.length > 0, 20_000);
      expect(postedMessages[0]).toEqual({ channel: "C123", text: "hello from the agent", thread_ts: "1700000000.000001" });
    },
    30_000,
  );

  it(
    "downloads a real image attachment (with the bot token) and forwards it to the model",
    async () => {
      postedMessages = [];
      llmRequestBodies = [];
      replyText = "reply about the image";

      const { status } = await postSignedSlackEvent(port, {
        type: "event_callback",
        event: {
          type: "message",
          subtype: "file_share",
          channel: "C123",
          ts: "1700000020.000001",
          text: "what's in this?",
          files: [{ mimetype: "image/png", url_private: `${slackApiBaseUrl}/files/f1.png` }],
        },
      });
      expect(status).toBe(200);

      await waitFor(() => postedMessages.length > 0, 20_000);
      expect(lastFileDownloadAuthHeader).toBe("Bearer xoxb-test-token");
      const userMessagePart = llmRequestBodies[0]?.messages.find((m) => m.role === "user");
      expect(JSON.stringify(userMessagePart?.content)).toContain(Buffer.from("fake png bytes").toString("base64"));
    },
    30_000,
  );

  it("ignores the bot's own message instead of replying to itself", async () => {
    postedMessages = [];
    const { status } = await postSignedSlackEvent(port, {
      type: "event_callback",
      event: { type: "message", channel: "C123", ts: "1700000010.000001", text: "an echo", bot_id: "B1" },
    });
    expect(status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(postedMessages).toHaveLength(0);
  });
});

describe("web-server Slack inbound channel — not configured", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-slack-unconfigured-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-slack-unconfigured-home-"));
    for (const k of ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "SLACK_API_BASE_URL", "FINANFA_PROVIDER", "FINANFA_BASE_URL", "FINANFA_MODEL"]) {
      delete process.env[k];
    }
    ({ child, port } = await spawnWebServer(projectDir, homeDir, 4985));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("404s instead of silently accepting unverifiable requests when SLACK_SIGNING_SECRET isn't set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/slack/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "x" }),
    });
    expect(res.status).toBe(404);
  });
});
