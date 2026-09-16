import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the Discord inbound channel — same shape as
// channels-slack.test.ts/channels-telegram.test.ts: the real web-server
// subprocess, a real Ed25519-signed HTTP request (real keypair, real
// node:crypto sign), a real fake LLM server, and a real fake Discord API
// server capturing the outgoing PATCH to the deferred interaction
// response.

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12).toString("hex");

function signDiscordRequest(rawBody: string): { timestamp: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = cryptoSign(null, Buffer.from(timestamp + rawBody, "utf-8"), privateKey).toString("hex");
  return { timestamp, signature };
}

async function postDiscordInteraction(port: number, payload: unknown): Promise<{ status: number; body: string }> {
  const rawBody = JSON.stringify(payload);
  const { timestamp, signature } = signDiscordRequest(rawBody);
  const res = await fetch(`http://127.0.0.1:${port}/api/channels/discord/interactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": signature },
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

describe("web-server Discord inbound channel (real subprocess, real Ed25519-signed request, real fake LLM + Discord API servers)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  let llmServer: http.Server;
  let llmBaseUrl: string;
  let replyText: string;
  let llmRequestBodies: { messages: { role: string; content: unknown }[] }[];

  let discordApiServer: http.Server;
  let discordApiBaseUrl: string;
  let patchRequests: { url: string; method: string; body: { content: string } }[];

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

    discordApiServer = http.createServer((req, res) => {
      if (req.url === "/cdn/pic.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from("fake png bytes"));
        return;
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        patchRequests.push({ url: req.url ?? "", method: req.method ?? "", body: JSON.parse(raw) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "1" }));
      });
    });
    await new Promise<void>((resolve) => discordApiServer.listen(0, "127.0.0.1", resolve));
    discordApiBaseUrl = `http://127.0.0.1:${(discordApiServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-discord-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-discord-home-"));

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.DISCORD_PUBLIC_KEY = PUBLIC_KEY_HEX;
    process.env.DISCORD_APPLICATION_ID = "app-123";
    process.env.DISCORD_API_BASE_URL = discordApiBaseUrl;

    ({ child, port } = await spawnWebServer(projectDir, homeDir, 5000));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    discordApiServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    for (const k of ["DISCORD_PUBLIC_KEY", "DISCORD_APPLICATION_ID", "DISCORD_API_BASE_URL"]) delete process.env[k];
  });

  it("answers Discord's PING handshake with a PONG", async () => {
    const { status, body } = await postDiscordInteraction(port, { type: 1 });
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ type: 1 });
  });

  it("rejects a request with an invalid signature", async () => {
    const rawBody = JSON.stringify({ type: 1 });
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/discord/interactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Signature-Timestamp": String(Math.floor(Date.now() / 1000)), "X-Signature-Ed25519": "ab".repeat(64) },
      body: rawBody,
    });
    expect(res.status).toBe(401);
  });

  it(
    "defers a /ask command, then PATCHes the real reply once the turn finishes",
    async () => {
      patchRequests = [];
      llmRequestBodies = [];
      replyText = "hello from the agent";

      const { status, body } = await postDiscordInteraction(port, {
        type: 2,
        channel_id: "555",
        token: "interaction-token-xyz",
        data: { name: "ask", options: [{ name: "message", type: 3, value: "hi there" }] },
      });
      expect(status).toBe(200);
      expect(JSON.parse(body)).toEqual({ type: 5 }); // deferred immediately, before the turn even runs

      await waitFor(() => patchRequests.length > 0, 20_000);
      expect(patchRequests[0]).toEqual({
        url: "/webhooks/app-123/interaction-token-xyz/messages/@original",
        method: "PATCH",
        body: { content: "hello from the agent" },
      });
    },
    30_000,
  );

  it(
    "downloads a real image attachment option and forwards it to the model",
    async () => {
      patchRequests = [];
      llmRequestBodies = [];
      replyText = "reply about the image";

      const { status } = await postDiscordInteraction(port, {
        type: 2,
        channel_id: "555",
        token: "interaction-token-img",
        data: {
          name: "ask",
          options: [
            { name: "message", type: 3, value: "what's this?" },
            { name: "image", type: 11, value: "att1" },
          ],
          resolved: { attachments: { att1: { url: `${discordApiBaseUrl}/cdn/pic.png`, content_type: "image/png" } } },
        },
      });
      expect(status).toBe(200);

      await waitFor(() => patchRequests.length > 0, 20_000);
      // Same channelId/session as the earlier test in this file, so the
      // request now carries that turn's history too — check the *last*
      // request's *last* user message, not the first of either.
      const lastRequest = llmRequestBodies.at(-1);
      const userMessagePart = [...(lastRequest?.messages ?? [])].reverse().find((m) => m.role === "user");
      expect(JSON.stringify(userMessagePart?.content)).toContain(Buffer.from("fake png bytes").toString("base64"));
    },
    30_000,
  );

  it("ignores a command that isn't /ask", async () => {
    patchRequests = [];
    const { status, body } = await postDiscordInteraction(port, {
      type: 2,
      channel_id: "555",
      token: "t",
      data: { name: "unknown", options: [] },
    });
    expect(status).toBe(200);
    expect(body).toBe("");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(patchRequests).toHaveLength(0);
  });
});

describe("web-server Discord inbound channel — not configured", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-discord-unconfigured-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-discord-unconfigured-home-"));
    for (const k of ["DISCORD_PUBLIC_KEY", "DISCORD_APPLICATION_ID", "DISCORD_API_BASE_URL"]) delete process.env[k];
    ({ child, port } = await spawnWebServer(projectDir, homeDir, 5005));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("404s instead of silently accepting unverifiable requests when DISCORD_PUBLIC_KEY isn't set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/discord/interactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: 1 }),
    });
    expect(res.status).toBe(404);
  });
});
