import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
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

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
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

// Real, reported feature: a permission-confirmation prompt now goes back
// out through the Discord channel as a real followup message with real
// tappable buttons, and a tapped button (a real message_component
// interaction) resolves the exact same pending confirmation a typed y/n
// reply would in another channel — own dedicated subprocess/servers so
// this doesn't touch the plain-text-reply fixtures above at all.
describe("web-server Discord inbound channel — real remote confirmation via buttons", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  let llmServer: http.Server;
  let llmBaseUrl: string;
  let callCount: number;

  let discordApiServer: http.Server;
  let discordApiBaseUrl: string;
  let sentRequests: { url: string; method: string; body: { content: string; components?: { components: { type: number; label: string; custom_id: string; style: number }[] }[] } }[];

  beforeAll(async () => {
    llmServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        callCount++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (callCount === 1) {
          const events = [
            JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: "" } }] } }] }),
            JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"note.txt","content":"hi"}' } }] } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ];
          for (const e of events) res.write(`data: ${e}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    llmBaseUrl = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}`;

    discordApiServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        sentRequests.push({ url: req.url ?? "", method: req.method ?? "", body: raw ? JSON.parse(raw) : {} });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "1" }));
      });
    });
    await new Promise<void>((resolve) => discordApiServer.listen(0, "127.0.0.1", resolve));
    discordApiBaseUrl = `http://127.0.0.1:${(discordApiServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-discord-confirm-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-discord-confirm-home-"));

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.DISCORD_PUBLIC_KEY = PUBLIC_KEY_HEX;
    process.env.DISCORD_APPLICATION_ID = "app-confirm";
    process.env.DISCORD_API_BASE_URL = discordApiBaseUrl;

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    discordApiServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    for (const k of ["DISCORD_PUBLIC_KEY", "DISCORD_APPLICATION_ID", "DISCORD_API_BASE_URL"]) delete process.env[k];
  });

  beforeEach(() => {
    callCount = 0;
    sentRequests = [];
  });

  it("sends the confirmation prompt as a real followup message with real buttons, and a tapped button (message_component) runs the tool", async () => {
    await postDiscordInteraction(port, {
      type: 2,
      channel_id: "999",
      token: "interaction-token-confirm",
      data: { name: "ask", options: [{ name: "message", type: 3, value: "write a note" }] },
    });

    await waitFor(() => sentRequests.some((r) => r.body.content?.includes('wants to run "write_file"')));
    const confirmationMessage = sentRequests.find((r) => r.body.content?.includes('wants to run "write_file"'));
    expect(confirmationMessage?.url).toBe("/webhooks/app-confirm/interaction-token-confirm");
    expect(confirmationMessage?.body.components?.[0]?.components).toEqual([
      { type: 2, label: "✅ Yes", custom_id: "confirm_y", style: 3 },
      { type: 2, label: "❌ No", custom_id: "confirm_n", style: 4 },
      { type: 2, label: "Always this action", custom_id: "confirm_a", style: 2 },
      { type: 2, label: "Always allow this tool", custom_id: "confirm_t", style: 2 },
    ]);

    // The real Discord message_component interaction shape for a tap on the "✅ Yes" button.
    const { status, body } = await postDiscordInteraction(port, { type: 3, channel_id: "999", data: { custom_id: "confirm_y" } });
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ type: 6 });

    await waitFor(() => sentRequests.some((r) => r.method === "PATCH" && r.body.content === "Done."));
    expect(await readFile(path.join(projectDir, "note.txt"), "utf-8")).toBe("hi");
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
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
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
