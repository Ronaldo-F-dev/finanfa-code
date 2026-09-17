import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the Feishu inbound channel — same shape as
// channels-line.test.ts: the real web-server subprocess, a real fake LLM
// server, and a real fake Feishu Open Platform server (auth + IM API)
// capturing the outgoing send-message call.

const VERIFICATION_TOKEN = "test-verification-token";

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

async function postFeishuWebhook(port: number, payload: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/channels/feishu/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

describe("web-server Feishu inbound channel (real subprocess, real fake LLM + Feishu Open Platform servers)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  let llmServer: http.Server;
  let llmBaseUrl: string;
  let replyText: string;

  let feishuServer: http.Server;
  let feishuBaseUrl: string;
  let sentMessages: { url: string; authHeader: string | undefined; body: { receive_id: string; msg_type: string; content: string } }[];

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

    feishuServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (req.url === "/open-apis/auth/v3/tenant_access_token/internal") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "test-tenant-token", expire: 7200 }));
          return;
        }
        sentMessages.push({ url: req.url ?? "", authHeader: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, msg: "ok" }));
      });
    });
    await new Promise<void>((resolve) => feishuServer.listen(0, "127.0.0.1", resolve));
    feishuBaseUrl = `http://127.0.0.1:${(feishuServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-feishu-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-feishu-home-"));

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.FEISHU_VERIFICATION_TOKEN = VERIFICATION_TOKEN;
    process.env.FEISHU_APP_ID = "cli_test";
    process.env.FEISHU_APP_SECRET = "test-secret";
    process.env.FEISHU_API_BASE_URL = feishuBaseUrl;

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    feishuServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    for (const k of ["FEISHU_VERIFICATION_TOKEN", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_API_BASE_URL"]) delete process.env[k];
  });

  it("rejects a request with an invalid/missing verification token", async () => {
    const { status } = await postFeishuWebhook(port, { header: { token: "wrong-token" } });
    expect(status).toBe(401);
  });

  it("answers the one-time url_verification handshake with the real challenge, before any token-gated logic", async () => {
    const { status, body } = await postFeishuWebhook(port, { type: "url_verification", challenge: "real-challenge-value", token: VERIFICATION_TOKEN });
    expect(status).toBe(200);
    expect(body).toEqual({ challenge: "real-challenge-value" });
  });

  it(
    "runs a real turn for an inbound message and replies to the right chat",
    async () => {
      sentMessages = [];
      replyText = "hello from the agent";

      const { status } = await postFeishuWebhook(port, {
        header: { event_id: "evt1", event_type: "im.message.receive_v1", token: VERIFICATION_TOKEN },
        event: {
          sender: { sender_type: "user" },
          message: { message_type: "text", chat_id: "oc_555", content: JSON.stringify({ text: "hi there" }) },
        },
      });
      expect(status).toBe(200);

      await waitFor(() => sentMessages.length > 0, 20_000);
      expect(sentMessages[0]!.url).toBe("/open-apis/im/v1/messages?receive_id_type=chat_id");
      expect(sentMessages[0]!.authHeader).toBe("Bearer test-tenant-token");
      expect(sentMessages[0]!.body).toEqual({ receive_id: "oc_555", msg_type: "text", content: JSON.stringify({ text: "hello from the agent" }) });
    },
    30_000,
  );

  it("ignores a redelivery of the same event_id — no second turn, no duplicate reply", async () => {
    sentMessages = [];
    replyText = "second reply that should never be sent";

    const { status } = await postFeishuWebhook(port, {
      header: { event_id: "evt1", event_type: "im.message.receive_v1", token: VERIFICATION_TOKEN },
      event: { sender: { sender_type: "user" }, message: { message_type: "text", chat_id: "oc_555", content: JSON.stringify({ text: "hi there" }) } },
    });
    expect(status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentMessages).toHaveLength(0);
  });
});

describe("web-server Feishu inbound channel — not configured", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-feishu-unconfigured-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-feishu-unconfigured-home-"));
    for (const k of ["FEISHU_VERIFICATION_TOKEN", "FEISHU_APP_ID", "FEISHU_APP_SECRET"]) delete process.env[k];
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("404s instead of silently accepting unverifiable requests when FEISHU_VERIFICATION_TOKEN isn't set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/feishu/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "x", token: "y" }),
    });
    expect(res.status).toBe(404);
  });
});
