import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { projectHash } from "@finanfa/core/src/core/session.js";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real, reported bug: a session's provider/endpoint was never persisted
// alongside its model — only the bare model string was. Resuming a
// session (a page reload, or — the exact case reported — the whole
// machine crashing and the web server restarting) always reconstructed
// the provider from the global/project default config, regardless of
// which provider that session's model actually needed. A session last
// using a local model (Ollama/Docker Model Runner/...) kept that model's
// name but silently talked to the default remote provider with it, which
// naturally rejected a model name it had never heard of.
//
// This test reproduces the exact scenario with two distinct real local
// HTTP servers standing in for "the default remote provider" and "a
// local model's own endpoint": switch to the local one, send a message
// (persists provider+model together), kill the server process entirely
// (simulating the crash/restart), start a fresh one, resume the same
// session, send another message with the unchanged model — and confirm
// it reaches the LOCAL server again, not the default one.
interface WsEvent {
  type: string;
  [key: string]: unknown;
}

function fakeSseServer(label: string): { server: http.Server; baseUrl: Promise<string>; requestCount: () => number } {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        JSON.stringify({ choices: [{ delta: { content: `reply from ${label}` } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
      ];
      for (const e of events) res.write(`data: ${e}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const baseUrl = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`));
  });
  return { server, baseUrl, requestCount: () => count };
}

// 30s, not the 10s this same helper uses in most e2e files: this test boots
// two real cold-start `npx tsx` servers, and 10s regularly wasn't enough for
// a single session_info once the machine was loaded (the failed runs even
// left orphan servers behind, which made the next run slower still).
function waitFor(events: WsEvent[], predicate: (e: WsEvent) => boolean, timeoutMs = 30_000): Promise<WsEvent> {
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

async function connect(port: number): Promise<{ ws: WebSocket; events: WsEvent[] }> {
  const events: WsEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  // Subscribed before awaiting "open", not after: the server sends
  // session_info as soon as its connection handler is ready, and a listener
  // attached only once the client observes "open" can miss it entirely (no
  // replay on a plain ws client). Latent since this test was written, it
  // started failing consistently once the server's startup got faster
  // (parallel startup loaders) — empty-events timeouts instead of the
  // assertion this test is actually about.
  ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  await waitFor(events, (e) => e.type === "session_info");
  return { ws, events };
}

describe("web-server: a resumed session reconstructs the right provider, not just the right model name", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams | undefined;
  let defaultServer: ReturnType<typeof fakeSseServer>;
  let localServer: ReturnType<typeof fakeSseServer>;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-resume-provider-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-resume-provider-home-"));

    defaultServer = fakeSseServer("default-remote");
    localServer = fakeSseServer("local-model");
    const defaultBaseUrl = await defaultServer.baseUrl;

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: defaultBaseUrl, model: "default-model", apiKey: "test-key" }),
    );
  }, 15_000);

  afterEach(() => {
    killWebServer(child);
    child = undefined;
  });

  afterAll(async () => {
    defaultServer?.server.close();
    localServer?.server.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it(
    "sends a resumed session's unchanged local model to its own endpoint again after a full server restart, not to the default provider",
    async () => {
      const localBaseUrl = await localServer.baseUrl;

      // --- First server instance: connect, switch to the local model, send a message ---
      let { child: firstChild, port: firstPort } = await spawnWebServer(projectDir, homeDir);
      child = firstChild;

      const { ws, events } = await connect(firstPort);
      const sessionInfo = events.find((e) => e.type === "session_info")!;
      const sessionId = sessionInfo.id as string;

      ws.send(JSON.stringify({ type: "set_model", model: "local-only-model", family: "openai-compatible", baseUrl: localBaseUrl }));
      ws.send(JSON.stringify({ type: "user_message", text: "hello" }));
      await waitFor(events, (e) => e.type === "assistant_end");
      expect(localServer.requestCount()).toBeGreaterThan(0);
      expect(defaultServer.requestCount()).toBe(0); // the switch actually took effect for this connection

      // assistant_end reaches this client before the session is persisted:
      // handleUserMessage's finally block runs only after a second, separate
      // LLM call (maybeGenerateTitle), then awaits session.persist(). Killing
      // the process 300ms later used to race that write, leaving the previous
      // model in the session file and making this test fail intermittently in
      // CI. Wait for the durable state instead of assuming a fixed delay is
      // enough — the crash simulation below is then honest: no sleep, the
      // process dies the instant the write this test depends on has landed.
      const sessionFile = path.join(homeDir, ".finanfa-code", "sessions", projectHash(projectDir), `${sessionId}.json`);
      await vi.waitFor(
        async () => {
          const raw = await readFile(sessionFile, "utf8").catch(() => "");
          expect(raw).toContain("local-only-model");
        },
        { timeout: 15_000 },
      );
      ws.close();

      // --- Simulate the crash/restart: kill this instance entirely, start a brand new one ---
      killWebServer(child);
      const localRequestsBeforeRestart = localServer.requestCount();
      const defaultRequestsBeforeRestart = defaultServer.requestCount();

      const second = await spawnWebServer(projectDir, homeDir);
      child = second.child;

      // --- Resume the same session on the fresh instance, send another message with the unchanged model ---
      const resumedWs = new WebSocket(`ws://127.0.0.1:${second.port}/ws?session=${sessionId}`);
      const resumedEvents: WsEvent[] = [];
      // Same before-open subscription as connect() above.
      resumedWs.on("message", (raw: Buffer) => resumedEvents.push(JSON.parse(raw.toString()) as WsEvent));
      await new Promise<void>((resolve, reject) => {
        resumedWs.on("open", () => resolve());
        resumedWs.on("error", reject);
      });
      await waitFor(resumedEvents, (e) => e.type === "session_info");

      const resumedInfo = resumedEvents.find((e) => e.type === "session_info")!;
      expect(resumedInfo.model).toBe("local-only-model"); // the model itself was always persisted correctly

      resumedWs.send(JSON.stringify({ type: "user_message", text: "still there?" }));
      await waitFor(resumedEvents, (e) => e.type === "assistant_end");
      resumedWs.close();

      // The real assertion: the resumed connection's request landed on the
      // SAME local server this model actually belongs to, not the default
      // one — before the fix, this would have gone to defaultServer with a
      // model name it had never heard of.
      expect(localServer.requestCount()).toBeGreaterThan(localRequestsBeforeRestart);
      expect(defaultServer.requestCount()).toBe(defaultRequestsBeforeRestart);
    },
    // Double the usual 30_000 every other single-spawn e2e test in this
    // directory uses — this one does TWO full cold-start `npx tsx` server
    // boots in a single test (the whole point: a real crash/restart), so
    // it genuinely needs twice the margin, not just under contention.
    60_000,
  );
});
