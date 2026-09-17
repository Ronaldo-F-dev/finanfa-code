import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the Matrix inbound channel — same shape as
// channels-telegram.test.ts: the real web-server subprocess, a real fake
// LLM server, and a real fake Matrix homeserver capturing the outgoing
// send-event call.

const HS_TOKEN = "test-hs-token";
const BOT_USER_ID = "@finanfa-bot:example.org";

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

async function putMatrixTransaction(port: number, txnId: string, payload: unknown, authHeader: string | undefined = `Bearer ${HS_TOKEN}`): Promise<{ status: number }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authHeader !== undefined) headers.authorization = authHeader;
  const res = await fetch(`http://127.0.0.1:${port}/api/channels/matrix/transactions/${txnId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });
  return { status: res.status };
}

describe("web-server Matrix inbound channel (real subprocess, real fake LLM + Matrix homeserver)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  let llmServer: http.Server;
  let llmBaseUrl: string;
  let replyText: string;

  let homeserver: http.Server;
  let homeserverUrl: string;
  let sentMessages: { url: string; authHeader: string | undefined; body: { msgtype: string; body: string } }[];

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

    homeserver = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        sentMessages.push({ url: req.url ?? "", authHeader: req.headers.authorization, body: JSON.parse(raw || "{}") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ event_id: "$real-event-id" }));
      });
    });
    await new Promise<void>((resolve) => homeserver.listen(0, "127.0.0.1", resolve));
    homeserverUrl = `http://127.0.0.1:${(homeserver.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-matrix-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-matrix-home-"));

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.MATRIX_HS_TOKEN = HS_TOKEN;
    process.env.MATRIX_BOT_USER_ID = BOT_USER_ID;
    process.env.MATRIX_HOMESERVER_URL = homeserverUrl;
    process.env.MATRIX_AS_TOKEN = "as-test-token";

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    homeserver.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    for (const k of ["MATRIX_HS_TOKEN", "MATRIX_BOT_USER_ID", "MATRIX_HOMESERVER_URL", "MATRIX_AS_TOKEN"]) delete process.env[k];
  });

  it("rejects a request with an invalid/missing hs_token", async () => {
    const { status } = await putMatrixTransaction(port, "txn1", { events: [] }, "Bearer wrong-token");
    expect(status).toBe(401);
  });

  it(
    "runs a real turn for an inbound message and replies to the right room",
    async () => {
      sentMessages = [];
      replyText = "hello from the agent";

      const { status } = await putMatrixTransaction(port, "txn2", {
        events: [{ type: "m.room.message", event_id: "$1", room_id: "!room1:example.org", sender: "@alice:example.org", content: { msgtype: "m.text", body: "hi there" } }],
      });
      expect(status).toBe(200);

      await waitFor(() => sentMessages.length > 0, 20_000);
      expect(sentMessages[0]!.url).toMatch(/^\/_matrix\/client\/v3\/rooms\/!room1%3Aexample\.org\/send\/m\.room\.message\//);
      expect(sentMessages[0]!.authHeader).toBe("Bearer as-test-token");
      expect(sentMessages[0]!.body).toEqual({ msgtype: "m.text", body: "hello from the agent" });
    },
    30_000,
  );

  it("ignores a redelivery of the same transaction id — no second turn, no duplicate reply", async () => {
    sentMessages = [];
    replyText = "second reply that should never be sent";

    const { status } = await putMatrixTransaction(port, "txn2", {
      // same txnId already handled by the earlier test in this file
      events: [{ type: "m.room.message", event_id: "$1", room_id: "!room1:example.org", sender: "@alice:example.org", content: { msgtype: "m.text", body: "hi there" } }],
    });
    expect(status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentMessages).toHaveLength(0);
  });

  it("ignores the bot's own echoed message — no reply sent", async () => {
    sentMessages = [];
    const { status } = await putMatrixTransaction(port, "txn3", {
      events: [{ type: "m.room.message", event_id: "$2", room_id: "!room1:example.org", sender: BOT_USER_ID, content: { msgtype: "m.text", body: "my own earlier reply" } }],
    });
    expect(status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentMessages).toHaveLength(0);
  });
});

describe("web-server Matrix inbound channel — not configured", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-matrix-unconfigured-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-matrix-unconfigured-home-"));
    for (const k of ["MATRIX_HS_TOKEN", "MATRIX_BOT_USER_ID", "MATRIX_HOMESERVER_URL", "MATRIX_AS_TOKEN"]) delete process.env[k];
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("404s instead of silently accepting unverifiable requests when MATRIX_HS_TOKEN isn't set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/matrix/transactions/txn1`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(404);
  });
});
