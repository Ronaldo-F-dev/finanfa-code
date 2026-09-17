import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the SMS inbound channel — same shape as
// channels-whatsapp.test.ts: the real web-server subprocess, a real
// Twilio-algorithm-signed form-urlencoded HTTP request, a real fake LLM
// server, and a real fake Twilio Messages API server capturing the
// outgoing send call.

const AUTH_TOKEN = "test-auth-token";

function signTwilioRequest(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", AUTH_TOKEN).update(data, "utf-8").digest("base64");
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

describe("web-server SMS inbound channel (real subprocess, real Twilio-signed request, real fake LLM + Twilio API servers)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let webhookUrl: string;

  let llmServer: http.Server;
  let llmBaseUrl: string;
  let replyText: string;

  let twilioApiServer: http.Server;
  let twilioApiBaseUrl: string;
  let sentMessages: { url: string; body: string; authHeader?: string }[];

  async function postSmsWebhook(params: Record<string, string>, signatureOverride?: string): Promise<{ status: number }> {
    const body = new URLSearchParams(params);
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signatureOverride ?? signTwilioRequest(webhookUrl, params) },
      body: body.toString(),
    });
    return { status: res.status };
  }

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

    twilioApiServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        sentMessages.push({ url: req.url ?? "", body: raw, authHeader: req.headers.authorization });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ sid: "SMreply" }));
      });
    });
    await new Promise<void>((resolve) => twilioApiServer.listen(0, "127.0.0.1", resolve));
    twilioApiBaseUrl = `http://127.0.0.1:${(twilioApiServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-sms-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-sms-home-"));

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.TWILIO_ACCOUNT_SID = "ACxxxx";
    process.env.TWILIO_FROM_NUMBER = "+15559876543";
    process.env.TWILIO_API_BASE_URL = twilioApiBaseUrl;

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
    webhookUrl = `http://127.0.0.1:${port}/api/channels/sms/webhook`;
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    twilioApiServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    for (const k of ["TWILIO_AUTH_TOKEN", "TWILIO_ACCOUNT_SID", "TWILIO_FROM_NUMBER", "TWILIO_API_BASE_URL"]) delete process.env[k];
  });

  it("rejects a request with an invalid signature", async () => {
    const { status } = await postSmsWebhook({ From: "+15551234567", To: "+15559876543", Body: "hi", MessageSid: "SM1" }, "sha1-forged");
    expect(status).toBe(401);
  });

  it(
    "runs a real turn for an inbound SMS and replies to the right number",
    async () => {
      sentMessages = [];
      replyText = "hello from the agent";

      const { status } = await postSmsWebhook({ From: "+15551234567", To: "+15559876543", Body: "hi there", MessageSid: "SM1" });
      expect(status).toBe(200); // acked immediately, before the turn even runs

      await waitFor(() => sentMessages.length > 0, 20_000);
      expect(sentMessages[0]!.url).toBe("/Accounts/ACxxxx/Messages.json");
      expect(sentMessages[0]!.authHeader).toBe(`Basic ${Buffer.from(`ACxxxx:${AUTH_TOKEN}`).toString("base64")}`);
      const params = new URLSearchParams(sentMessages[0]!.body);
      expect(params.get("To")).toBe("+15551234567");
      expect(params.get("Body")).toBe("hello from the agent");
    },
    30_000,
  );

  it("ignores a redelivery of the same MessageSid — no second turn, no duplicate reply", async () => {
    sentMessages = [];
    replyText = "second reply that should never be sent";

    const { status } = await postSmsWebhook({ From: "+15551234567", To: "+15559876543", Body: "hi there", MessageSid: "SM1" }); // same MessageSid as the earlier test
    expect(status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentMessages).toHaveLength(0);
  });
});

describe("web-server SMS inbound channel — not configured", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-sms-unconfigured-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-sms-unconfigured-home-"));
    for (const k of ["TWILIO_AUTH_TOKEN", "TWILIO_ACCOUNT_SID", "TWILIO_FROM_NUMBER", "TWILIO_API_BASE_URL"]) delete process.env[k];
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("404s instead of silently accepting unverifiable requests when TWILIO_AUTH_TOKEN isn't set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/sms/webhook`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: "+1", To: "+1", Body: "hi", MessageSid: "SM1" }).toString(),
    });
    expect(res.status).toBe(404);
  });
});
