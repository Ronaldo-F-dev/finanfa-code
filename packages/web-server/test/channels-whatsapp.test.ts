import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the WhatsApp inbound channel — same shape as
// channels-telegram.test.ts: the real web-server subprocess, a real
// HMAC-SHA256-signed HTTP request, a real fake LLM server, and a real
// fake WhatsApp Cloud API server capturing the outgoing send call.

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";

function signBody(rawBody: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;
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

async function postWhatsappEvent(port: number, payload: unknown, signatureOverride?: string): Promise<{ status: number }> {
  const rawBody = JSON.stringify(payload);
  const res = await fetch(`http://127.0.0.1:${port}/api/channels/whatsapp/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Hub-Signature-256": signatureOverride ?? signBody(rawBody) },
    body: rawBody,
  });
  return { status: res.status };
}

function messagePayload(from: string, messageId: string, text: string): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry1",
        changes: [
          {
            field: "messages",
            value: { messaging_product: "whatsapp", metadata: { phone_number_id: "123" }, messages: [{ from, id: messageId, type: "text", text: { body: text } }] },
          },
        ],
      },
    ],
  };
}

describe("web-server WhatsApp inbound channel (real subprocess, real HMAC-signed request, real fake LLM + WhatsApp API servers)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  let llmServer: http.Server;
  let llmBaseUrl: string;
  let replyText: string;

  let whatsappApiServer: http.Server;
  let whatsappApiBaseUrl: string;
  let sentMessages: { url: string; body: { to: string; text: { body: string } } }[];

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

    whatsappApiServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        sentMessages.push({ url: req.url ?? "", body: JSON.parse(raw) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ messages: [{ id: "wamid.reply" }] }));
      });
    });
    await new Promise<void>((resolve) => whatsappApiServer.listen(0, "127.0.0.1", resolve));
    whatsappApiBaseUrl = `http://127.0.0.1:${(whatsappApiServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-whatsapp-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-whatsapp-home-"));

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
    process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    process.env.WHATSAPP_API_BASE_URL = whatsappApiBaseUrl;

    ({ child, port } = await spawnWebServer(projectDir, homeDir, 5010));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    whatsappApiServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    for (const k of ["WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_API_BASE_URL"]) delete process.env[k];
  });

  it("answers Meta's GET verification handshake by echoing the challenge", async () => {
    const url = `http://127.0.0.1:${port}/api/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("12345");
  });

  it("rejects a GET handshake with the wrong verify token", async () => {
    const url = `http://127.0.0.1:${port}/api/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`;
    const res = await fetch(url);
    expect(res.status).toBe(403);
  });

  it("rejects a POST request with an invalid signature", async () => {
    const { status } = await postWhatsappEvent(port, messagePayload("15551234567", "wamid.1", "hi"), "sha256=deadbeef");
    expect(status).toBe(401);
  });

  it(
    "runs a real turn for an inbound message and replies to the right WhatsApp number",
    async () => {
      sentMessages = [];
      replyText = "hello from the agent";

      const { status } = await postWhatsappEvent(port, messagePayload("15551234567", "wamid.1", "hi there"));
      expect(status).toBe(200); // acked immediately, before the turn even runs

      await waitFor(() => sentMessages.length > 0, 20_000);
      expect(sentMessages[0]!.url).toBe("/123456/messages");
      expect(sentMessages[0]!.body).toMatchObject({ to: "15551234567", text: { body: "hello from the agent" } });
    },
    30_000,
  );

  it("ignores a redelivery of the same message id — no second turn, no duplicate reply", async () => {
    sentMessages = [];
    replyText = "second reply that should never be sent";

    const { status } = await postWhatsappEvent(port, messagePayload("15551234567", "wamid.1", "hi there")); // same message id as the earlier test
    expect(status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentMessages).toHaveLength(0);
  });

  it("ignores a non-message webhook (e.g. a status/delivery-receipt update) — no reply sent", async () => {
    sentMessages = [];
    const { status } = await postWhatsappEvent(port, {
      object: "whatsapp_business_account",
      entry: [{ id: "entry1", changes: [{ field: "messages", value: { statuses: [{ id: "wamid.1", status: "delivered" }] } }] }],
    });
    expect(status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentMessages).toHaveLength(0);
  });
});

describe("web-server WhatsApp inbound channel — not configured", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-whatsapp-unconfigured-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-whatsapp-unconfigured-home-"));
    for (const k of ["WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_API_BASE_URL"]) delete process.env[k];
    ({ child, port } = await spawnWebServer(projectDir, homeDir, 5015));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("404s the GET handshake instead of silently accepting it when WHATSAPP_VERIFY_TOKEN isn't set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`);
    expect(res.status).toBe(404);
  });

  it("404s a POST event instead of silently accepting unverifiable requests when WHATSAPP_APP_SECRET isn't set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/whatsapp/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object: "whatsapp_business_account" }),
    });
    expect(res.status).toBe(404);
  });
});
