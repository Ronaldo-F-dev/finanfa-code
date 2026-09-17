import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

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

// Real reported bug: clicking Stop mid-turn appeared to do nothing — the
// user had to reload the page to regain control. Root cause: the per-
// connection message queue added to fix a real set_effort/user_message race
// (see switch-model-provider.test.ts) accidentally serialized "interrupt"
// behind the in-flight user_message's own handler, which awaits the whole
// turn — so by the time interrupt's abort() calls ran, the turn had already
// finished on its own and activeAbortControllers was empty. A no-op,
// indistinguishable from Stop doing nothing at all.
describe("web-server: interrupt actually aborts an in-flight turn instead of waiting behind it in the message queue", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let server: http.Server;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-interrupt-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-interrupt-home-"));

    // Streams real SSE chunks slowly (one every 500ms) so a turn stays open
    // long enough to send interrupt mid-stream and observe it actually cut
    // things short — a real, reproduced race, not a mocked abort.
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "chunk0 " } }] })}\n\n`);
        let i = 0;
        const interval = setInterval(() => {
          i++;
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `chunk${i} ` } }] })}\n\n`);
          if (i >= 40) {
            clearInterval(interval);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          }
        }, 500);
        req.on("close", () => clearInterval(interval));
      });
    });
    const baseUrl = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`));
    });

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl, model: "fake-model", apiKey: "test-key" }),
    );

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 20_000);

  afterAll(async () => {
    killWebServer(child);
    server?.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it(
    "sending interrupt while a turn is streaming ends it in well under the ~20s the full stream would take",
    async () => {
      const events: WsEvent[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
      await waitFor(events, (e) => e.type === "session_info");

      ws.send(JSON.stringify({ type: "user_message", text: "go slow" }));
      // Let a few real chunks actually arrive first — this must be a real
      // mid-stream interrupt, not one that races the turn's own start.
      await waitFor(events, (e) => e.type === "assistant_delta");

      const start = Date.now();
      ws.send(JSON.stringify({ type: "interrupt" }));
      await waitFor(events, (e) => e.type === "busy" && e.busy === false, 8_000);
      const elapsed = Date.now() - start;

      // The full stream (40 chunks * 500ms) takes ~20s; a working interrupt
      // ends the turn in a couple of seconds at most. This is the actual
      // regression check: before the fix, this would time out waiting for
      // busy:false at 8s (the interrupt sat queued behind the still-running
      // turn) instead of the turn ending promptly.
      expect(elapsed).toBeLessThan(8_000);

      ws.close();
    },
    20_000,
  );
});
