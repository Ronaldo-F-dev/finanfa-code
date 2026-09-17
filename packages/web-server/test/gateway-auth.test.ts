import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the opt-in "Gateway" multi-user auth layer
// (see auth.ts): a real fake LLM server so a real turn actually runs, a
// real HTTP client for the REST session endpoints, and a real `ws`
// client for the WebSocket protocol — exercising two distinct users
// (alice/bob) against one running server instance to prove session
// isolation, not just that a token is checked.

interface WsEvent {
  type: string;
  [key: string]: unknown;
}

function waitFor(events: WsEvent[], predicate: (e: WsEvent) => boolean, timeoutMs = 10_000): Promise<WsEvent> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for event: ${JSON.stringify(events)}`));
      setTimeout(check, 50);
    };
    check();
  });
}

/** session.persist() runs slightly AFTER the "assistant_end" WS event fires (see loop.ts) — polls instead of asserting on the very first fetch, to avoid a real race with that write-to-disk. */
async function waitForSessionListed(port: number, token: string, sessionId: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const list = (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json())) as {
      sessions: { id: string }[];
    };
    if (list.sessions.some((s) => s.id === sessionId)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for session ${sessionId} to be listed`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function connectAndRunTurn(port: number, token: string, sessionId?: string): Promise<{ ws: WebSocket; events: WsEvent[] }> {
  const events: WsEvent[] = [];
  const qs = new URLSearchParams({ model: "test-model", token });
  if (sessionId) qs.set("session", sessionId);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs.toString()}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
  await waitFor(events, (e) => e.type === "session_info");
  return { ws, events };
}

describe("Gateway: multi-user auth and per-user session isolation (real subprocess, real WebSocket, real fake LLM server)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let llmServer: http.Server;
  let llmBaseUrl: string;

  beforeAll(async () => {
    llmServer = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    llmBaseUrl = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-gateway-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-gateway-home-"));
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.FINANFA_WEB_USERS = "alice:tok-alice,bob:tok-bob";
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    delete process.env.FINANFA_WEB_USERS;
  });

  it("401s a REST request with no Authorization header", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(res.status).toBe(401);
  });

  it("401s a REST request with an invalid token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: "Bearer not-a-real-token" } });
    expect(res.status).toBe(401);
  });

  it("closes a WebSocket connection with no ?token=", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?model=test-model`);
    const closeCode = await new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    expect(closeCode).toBe(4001);
  });

  it("closes a WebSocket connection with an invalid ?token=", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?model=test-model&token=forged`);
    const closeCode = await new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    expect(closeCode).toBe(4001);
  });

  it(
    "isolates one user's session from another's — listing, resuming, and deleting",
    async () => {
      // alice creates a real session with a real turn.
      const alice = await connectAndRunTurn(port, "tok-alice");
      alice.ws.send(JSON.stringify({ type: "user_message", text: "hi" }));
      await waitFor(alice.events, (e) => e.type === "assistant_end");
      const aliceSessionInfo = alice.events.find((e) => e.type === "session_info")!;
      const aliceSessionId = aliceSessionInfo.id as string;
      alice.ws.close();

      // alice sees her own session listed (persist() runs shortly after
      // assistant_end — see waitForSessionListed's own comment).
      await waitForSessionListed(port, "tok-alice", aliceSessionId);

      // bob does NOT see alice's session.
      const bobList = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: "Bearer tok-bob" } }).then((r) => r.json());
      expect((bobList as { sessions: { id: string }[] }).sessions.some((s) => s.id === aliceSessionId)).toBe(false);

      // bob can't resume alice's session over WebSocket — connection is refused.
      const bobResume = new WebSocket(`ws://127.0.0.1:${port}/ws?model=test-model&token=tok-bob&session=${aliceSessionId}`);
      const bobCloseCode = await new Promise<number>((resolve) => bobResume.on("close", (code) => resolve(code)));
      expect(bobCloseCode).toBe(4003);

      // bob can't delete alice's session over REST either.
      const bobDelete = await fetch(`http://127.0.0.1:${port}/api/sessions/${aliceSessionId}`, { method: "DELETE", headers: { Authorization: "Bearer tok-bob" } });
      expect(bobDelete.status).toBe(403);

      // alice can delete her own session.
      const aliceDelete = await fetch(`http://127.0.0.1:${port}/api/sessions/${aliceSessionId}`, { method: "DELETE", headers: { Authorization: "Bearer tok-alice" } });
      expect(aliceDelete.status).toBe(200);
    },
    20_000,
  );

  it("alice can resume her own session without any issue", async () => {
    const first = await connectAndRunTurn(port, "tok-alice");
    first.ws.send(JSON.stringify({ type: "user_message", text: "hi again" }));
    await waitFor(first.events, (e) => e.type === "assistant_end");
    const sessionId = first.events.find((e) => e.type === "session_info")!.id as string;
    first.ws.close();

    const resumed = await connectAndRunTurn(port, "tok-alice", sessionId);
    const sessionInfo = await waitFor(resumed.events, (e) => e.type === "session_info");
    expect(sessionInfo.id).toBe(sessionId);
    resumed.ws.close();
  });
});

describe("Gateway auth off by default (FINANFA_WEB_USERS unset)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-gateway-off-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-gateway-off-home-"));
    delete process.env.FINANFA_WEB_USERS;
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("REST session listing works with no Authorization header at all", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(res.status).toBe(200);
  });

  it("a WebSocket connection with no ?token= is accepted", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?model=test-model`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.close();
  });
});
