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

// Real reported gap: --prompt's own CLI auto-continue (cli.ts) exists
// because a one-shot scripted invocation has no human to type "continue"
// after the step-limit guard cuts a turn off. The web UI does have a human
// present, but making them notice a cutoff and manually resend "continue"
// for something like "build me a complete app" is exactly the friction
// --max-turns removed on the CLI side — this gives the web session the same
// automatic recovery (see WEB_MAX_AUTO_CONTINUE_TURNS in index.ts), each
// step still announced via a system message so it's never silent.
describe("web-server: auto-continues past the step-limit guard, mirroring the CLI's --prompt behavior", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let server: http.Server;
  let requestCount = 0;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-autocontinue-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-autocontinue-home-"));

    // The first 2 requests mimic the loop guard's own cutoff message
    // (matches isLoopGuardStopMessage's "(stopped" prefix); the 3rd is a
    // real final answer — confirms auto-continue stops as soon as a turn
    // actually finishes, not just when it exhausts every available retry.
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requestCount++;
        const content = requestCount <= 2 ? "(stopped after 150 steps without finishing — try breaking it up)" : "All done for real.";
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
        ];
        for (const e of events) res.write(`data: ${e}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
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

    ({ child, port } = await spawnWebServer(projectDir, homeDir, 4980));
  }, 20_000);

  afterAll(async () => {
    killWebServer(child);
    server?.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it(
    "sends \"continue\" automatically after a guard cutoff, and stops once a real final answer arrives",
    async () => {
      const events: WsEvent[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
      await waitFor(events, (e) => e.type === "session_info");

      ws.send(JSON.stringify({ type: "user_message", text: "build a big app" }));
      // 3 runTurn calls happen internally (2 guard cutoffs + 1 real finish),
      // each ending in its own assistant_end — waiting for the 3rd is the
      // real signal the whole auto-continue chain has finished, since the
      // final answer itself streams as assistant_delta events, not a
      // "system" one.
      await waitFor(events, () => events.filter((x) => x.type === "assistant_end").length >= 3);

      // 3 real runTurn calls (2 cutoffs + 1 finish) plus 1 maybeGenerateTitle
      // call after the loop, same as the CLI's own --prompt test expects.
      expect(requestCount).toBe(4);
      expect(events.some((e) => e.type === "assistant_delta" && typeof e.text === "string" && (e.text as string).includes("All done for real"))).toBe(
        true,
      );
      expect(events.filter((e) => e.type === "system" && typeof e.text === "string" && (e.text as string).includes("auto-continuing"))).toHaveLength(2);

      ws.close();
    },
    20_000,
  );
});
