import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { spawnWebServer } from "./support/spawn-server.js";

// Real, reported gap: a failed turn's error ("the model call failed: ...")
// only ever reached the browser as a one-off WS "error" event — never
// part of session.messages (appending it there would resend it to the
// model on every later call) — so reopening/resuming a session silently
// dropped it, unlike the ordinary chat text either side of it. Verifies
// the fix end to end: a real failed call (a real local HTTP server
// returning 400), a real successful one right after, a real disconnect +
// reconnect with ?session=, and the resumed "history" event containing
// the error in between the two real messages, not just the two messages
// alone.
interface WsEvent {
  type: string;
  [key: string]: unknown;
}

function fakeServer(): { server: http.Server; baseUrl: Promise<string> } {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      callCount++;
      if (callCount === 1) {
        // Fails outright — a non-retryable status, so this resolves fast.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "deliberately broken for this test" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        JSON.stringify({ choices: [{ delta: { content: "ok now" } }] }),
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
  return { server, baseUrl };
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

describe("web-server: a resumed session replays past errors, not just the ordinary chat text", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let fake: ReturnType<typeof fakeServer>;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-error-log-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-error-log-home-"));
    fake = fakeServer();
    const baseUrl = await fake.baseUrl;

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl, model: "fake-model", apiKey: "test-key" }),
    );
  }, 15_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    fake?.server.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it(
    "interleaves a past error between the two real messages either side of it, after a reconnect",
    async () => {
      const first = await spawnWebServer(projectDir, homeDir, 4980);
      child = first.child;

      const events: WsEvent[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${first.port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
      await waitFor(events, (e) => e.type === "session_info");
      const sessionId = (events.find((e) => e.type === "session_info") as WsEvent).id as string;

      ws.send(JSON.stringify({ type: "user_message", text: "this one fails" }));
      // A failed turn is shown via a "system" event (ui.writeSystem, see
      // loop.ts's catch block) not "error" (ui.writeError is for other
      // things, e.g. a malformed WS message) — same event this test's own
      // errorLog fix now also persists.
      await waitFor(events, (e) => e.type === "system" && typeof e.text === "string" && e.text.includes("the model call failed"));

      ws.send(JSON.stringify({ type: "user_message", text: "this one works" }));
      await waitFor(events, (e) => e.type === "assistant_end");
      ws.close();
      await new Promise((r) => setTimeout(r, 200)); // let session.persist() from the finally block land

      const second = await spawnWebServer(projectDir, homeDir, 4990);
      child.kill("SIGTERM");
      child = second.child;

      const resumedEvents: WsEvent[] = [];
      const resumedWs = new WebSocket(`ws://127.0.0.1:${second.port}/ws?session=${sessionId}`);
      await new Promise<void>((resolve, reject) => {
        resumedWs.on("open", () => resolve());
        resumedWs.on("error", reject);
      });
      resumedWs.on("message", (raw: Buffer) => resumedEvents.push(JSON.parse(raw.toString()) as WsEvent));
      const historyEvent = await waitFor(resumedEvents, (e) => e.type === "history");
      resumedWs.close();

      const replayed = historyEvent.messages as { role: string; content: string }[];
      const roles = replayed.map((m) => m.role);
      expect(roles).toContain("error");
      const errorIdx = roles.indexOf("error");
      // The error happened right after "this one fails" and before "this
      // one works" — both real user messages must still be there, in order,
      // on either side of it.
      expect(replayed[errorIdx - 1]?.content).toBe("this one fails");
      expect(roles.slice(errorIdx + 1)).toContain("user");
      expect(replayed.some((m) => m.content === "this one works")).toBe(true);
    },
    30_000,
  );
});
