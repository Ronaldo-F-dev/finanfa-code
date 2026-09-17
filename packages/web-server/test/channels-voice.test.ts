import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the Voice inbound channel — same signing
// helper/shape as channels-sms.test.ts, a real fake LLM server, and (for
// the timeout-fallback test) a real fake Twilio Messages API server.

const AUTH_TOKEN = "test-auth-token";

function signTwilioRequest(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", AUTH_TOKEN).update(data, "utf-8").digest("base64");
}

describe("web-server Voice inbound channel (real subprocess, real Twilio-signed request, real fake LLM server)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let callWebhookUrl: string;
  let gatherWebhookUrl: string;

  let llmServer: http.Server;
  let llmBaseUrl: string;
  let replyText: string;
  let replyDelayMs: number;

  async function post(url: string, params: Record<string, string>, signatureOverride?: string): Promise<{ status: number; body: string }> {
    const body = new URLSearchParams(params);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signatureOverride ?? signTwilioRequest(url, params) },
      body: body.toString(),
    });
    return { status: res.status, body: await res.text() };
  }

  beforeAll(async () => {
    llmServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        if (replyDelayMs > 0) await new Promise((r) => setTimeout(r, replyDelayMs));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    llmBaseUrl = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-voice-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-voice-home-"));

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
    callWebhookUrl = `http://127.0.0.1:${port}/api/channels/voice/webhook`;
    gatherWebhookUrl = `http://127.0.0.1:${port}/api/channels/voice/gather`;
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  it("rejects a call-start request with an invalid signature", async () => {
    const { status } = await post(callWebhookUrl, { CallSid: "CA1", From: "+15551234567", To: "+15559876543" }, "sha1-forged");
    expect(status).toBe(401);
  });

  it("answers a new call with a real Gather/Say TwiML prompt", async () => {
    const { status, body } = await post(callWebhookUrl, { CallSid: "CA1", From: "+15551234567", To: "+15559876543" });
    expect(status).toBe(200);
    expect(body).toContain("<Gather");
    expect(body).toContain("/api/channels/voice/gather");
    expect(body).toContain("how can I help");
  });

  it(
    "runs a real turn for the caller's speech and speaks the real reply back, re-gathering for a follow-up",
    async () => {
      replyText = "the weather is sunny";
      replyDelayMs = 0;
      const { status, body } = await post(gatherWebhookUrl, { CallSid: "CA2", From: "+15551234567", SpeechResult: "what's the weather" });
      expect(status).toBe(200);
      expect(body).toContain("the weather is sunny");
      expect(body).toContain("<Gather"); // conversation continues
    },
    15_000,
  );

  it("hangs up cleanly when Twilio's own speech recognition heard nothing", async () => {
    const { status, body } = await post(gatherWebhookUrl, { CallSid: "CA3", From: "+15551234567", SpeechResult: "" });
    expect(status).toBe(200);
    expect(body).toContain("<Hangup/>");
    expect(body).not.toContain("<Gather");
  });

  it(
    "tells the caller honestly and hangs up when the turn takes longer than the webhook can wait, without ever leaving the request hanging",
    async () => {
      replyText = "eventually finished";
      replyDelayMs = 9_000; // longer than channels-voice.ts's own TURN_DEADLINE_MS
      const start = Date.now();
      const { status, body } = await post(gatherWebhookUrl, { CallSid: "CA4", From: "+15551234567", SpeechResult: "a very slow question" });
      const elapsedMs = Date.now() - start;
      expect(status).toBe(200);
      expect(body).toContain("<Hangup/>");
      expect(elapsedMs).toBeLessThan(9_000); // responded well before the slow turn actually finished
      replyDelayMs = 0;
    },
    15_000,
  );
});

describe("web-server Voice inbound channel — not configured", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-voice-unconfigured-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-voice-unconfigured-home-"));
    delete process.env.TWILIO_AUTH_TOKEN;
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("404s instead of silently accepting unverifiable requests when TWILIO_AUTH_TOKEN isn't set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/voice/webhook`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "CA1", From: "+1", To: "+1" }).toString(),
    });
    expect(res.status).toBe(404);
  });
});
