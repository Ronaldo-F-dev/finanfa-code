import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the Teams inbound channel — same shape as
// channels-feishu.test.ts: the real web-server subprocess, a real fake
// LLM server, and a real fake set of Microsoft endpoints (OpenID config +
// JWKS for inbound token verification, OAuth2 token + Bot Framework
// Connector API for the outbound reply) — with a REAL RSA keypair
// signing REAL JWTs, not a mocked verification step.

const APP_ID = "00000000-0000-0000-0000-000000000001";
const KID = "test-key-1";

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signJwt(privateKey: KeyObject, payload: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT", kid: KID };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

function validBotFrameworkToken(privateKey: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(privateKey, { iss: "https://api.botframework.com", aud: APP_ID, exp: now + 3600, nbf: now - 60 });
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

async function postTeamsActivity(port: number, activity: unknown, token: string | undefined): Promise<{ status: number }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/channels/teams/webhook`, { method: "POST", headers, body: JSON.stringify(activity) });
  return { status: res.status };
}

describe("web-server Teams inbound channel (real subprocess, real fake LLM + real fake Microsoft endpoints, real signed JWTs)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  let llmServer: http.Server;
  let llmBaseUrl: string;
  let replyText: string;

  let msServer: http.Server;
  let msBaseUrl: string;
  let publicKey: KeyObject;
  let privateKey: KeyObject;
  let sentMessages: { url: string; authHeader: string | undefined; body: { type: string; text: string } }[];

  beforeAll(async () => {
    ({ publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }));

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

    msServer = http.createServer((req, res) => {
      if (req.url === "/openid-config") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jwks_uri: `${msBaseUrl}/jwks` }));
        return;
      }
      if (req.url === "/jwks") {
        const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [{ ...jwk, kid: KID, use: "sig" }] }));
        return;
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (req.url === "/token") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "real-looking-connector-token", expires_in: 3600 }));
          return;
        }
        sentMessages.push({ url: req.url ?? "", authHeader: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "activity-out-1" }));
      });
    });
    await new Promise<void>((resolve) => msServer.listen(0, "127.0.0.1", resolve));
    msBaseUrl = `http://127.0.0.1:${(msServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-teams-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-teams-home-"));

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.MICROSOFT_APP_ID = APP_ID;
    process.env.MICROSOFT_APP_PASSWORD = "test-secret";
    process.env.MICROSOFT_OPENID_CONFIG_URL = `${msBaseUrl}/openid-config`;
    process.env.MICROSOFT_TOKEN_URL = `${msBaseUrl}/token`;

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    msServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    for (const k of ["MICROSOFT_APP_ID", "MICROSOFT_APP_PASSWORD", "MICROSOFT_OPENID_CONFIG_URL", "MICROSOFT_TOKEN_URL"]) delete process.env[k];
  });

  it("rejects a request with no Authorization header", async () => {
    const { status } = await postTeamsActivity(port, { type: "message" }, undefined);
    expect(status).toBe(401);
  });

  it("rejects a request with an invalid (wrong-audience) token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const wrongAudienceToken = signJwt(privateKey, { iss: "https://api.botframework.com", aud: "some-other-app", exp: now + 3600, nbf: now - 60 });
    const { status } = await postTeamsActivity(port, { type: "message", id: "a1", serviceUrl: msBaseUrl, conversation: { id: "c1" }, text: "hi" }, wrongAudienceToken);
    expect(status).toBe(401);
  });

  it(
    "runs a real turn for an inbound message and posts the reply via the real Bot Framework Connector API",
    async () => {
      sentMessages = [];
      replyText = "hello from the agent";

      const { status } = await postTeamsActivity(
        port,
        { type: "message", id: "activity-1", serviceUrl: msBaseUrl, conversation: { id: "conv-1" }, text: "hi there" },
        validBotFrameworkToken(privateKey),
      );
      expect(status).toBe(200);

      await waitFor(() => sentMessages.length > 0, 20_000);
      expect(sentMessages[0]!.url).toBe("/v3/conversations/conv-1/activities/activity-1");
      expect(sentMessages[0]!.authHeader).toBe("Bearer real-looking-connector-token");
      expect(sentMessages[0]!.body).toEqual({ type: "message", text: "hello from the agent" });
    },
    30_000,
  );

  it("ignores a redelivery of the same activity id — no second turn, no duplicate reply", async () => {
    sentMessages = [];
    replyText = "second reply that should never be sent";

    const { status } = await postTeamsActivity(
      port,
      { type: "message", id: "activity-1", serviceUrl: msBaseUrl, conversation: { id: "conv-1" }, text: "hi there" },
      validBotFrameworkToken(privateKey),
    );
    expect(status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentMessages).toHaveLength(0);
  });

  it("ignores a non-message activity (e.g. conversationUpdate) — no reply sent", async () => {
    sentMessages = [];
    const { status } = await postTeamsActivity(
      port,
      { type: "conversationUpdate", id: "activity-2", serviceUrl: msBaseUrl, conversation: { id: "conv-1" } },
      validBotFrameworkToken(privateKey),
    );
    expect(status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentMessages).toHaveLength(0);
  });
});

describe("web-server Teams inbound channel — not configured", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-teams-unconfigured-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-teams-unconfigured-home-"));
    for (const k of ["MICROSOFT_APP_ID", "MICROSOFT_APP_PASSWORD"]) delete process.env[k];
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("404s instead of silently accepting unverifiable requests when MICROSOFT_APP_ID isn't set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/teams/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer whatever" },
      body: JSON.stringify({ type: "message" }),
    });
    expect(res.status).toBe(404);
  });
});
