import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { isOllamaAvailable, listOllamaModels } from "@finanfa/core/src/core/ollama-models.js";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real, reported bug: switching FROM a local model (a specific baseUrl
// override, e.g. Ollama/Docker Model Runner) back TO a normal same-family
// model (the configured default openai-compatible provider, e.g. Poolside)
// left the request going to the OLD local server with the NEW model's
// name — the family hadn't changed ("openai-compatible" both times), so
// the rebuild only fired for msg.baseUrl-carrying switches, never for
// "switch back to the default, no baseUrl" ones. Two real local HTTP
// servers stand in for "the local model's own endpoint" and "the default
// configured provider" — same setup as resume-provider.test.ts, but
// exercised within a single connection (no restart needed to hit this
// one).
interface WsEvent {
  type: string;
  [key: string]: unknown;
}

function fakeSseServer(label: string): { server: http.Server; baseUrl: Promise<string>; requestedModels: () => string[] } {
  const requestedModels: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        requestedModels.push((JSON.parse(body) as { model?: string }).model ?? "");
      } catch {
        requestedModels.push("");
      }
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
  return { server, baseUrl, requestedModels: () => requestedModels };
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

describe("web-server: switching back to a default-family model after a local one uses the right endpoint", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let defaultServer: ReturnType<typeof fakeSseServer>;
  let localServer: ReturnType<typeof fakeSseServer>;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-switch-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-switch-home-"));

    defaultServer = fakeSseServer("default-remote");
    localServer = fakeSseServer("local-model");
    const defaultBaseUrl = await defaultServer.baseUrl;

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: defaultBaseUrl, model: "default/laguna", apiKey: "test-key" }),
    );

    ({ child, port } = await spawnWebServer(projectDir, homeDir, 4970));
  }, 20_000);

  afterAll(async () => {
    killWebServer(child);
    defaultServer?.server.close();
    localServer?.server.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it(
    "sends the request to the default server again, not the stale local one, after switching back",
    async () => {
      const localBaseUrl = await localServer.baseUrl;
      const events: WsEvent[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
      await waitFor(events, (e) => e.type === "session_info");

      // Start on the project's default model (no explicit switch needed —
      // it's what the session started with), then switch TO the local one.
      ws.send(JSON.stringify({ type: "set_model", model: "local-only-model", family: "openai-compatible", baseUrl: localBaseUrl }));
      ws.send(JSON.stringify({ type: "user_message", text: "hello local" }));
      await waitFor(events, (e) => e.type === "assistant_end");
      expect(localServer.requestedModels()).toContain("local-only-model");

      // Now switch BACK to the default-family model, no baseUrl — the
      // exact case that used to leave the request pointed at localServer.
      ws.send(JSON.stringify({ type: "set_model", model: "default/laguna", family: "openai-compatible" }));
      ws.send(JSON.stringify({ type: "user_message", text: "hello again" }));
      await waitFor(events, (e) => e.type === "assistant_end" && events.filter((x) => x.type === "assistant_end").length >= 2);

      expect(defaultServer.requestedModels()).toContain("default/laguna");
      // The critical assertion: localServer must NEVER have seen this model
      // name — before the fix, it did (and 404'd on the real server).
      expect(localServer.requestedModels()).not.toContain("default/laguna");

      ws.close();
    },
    20_000,
  );

  it(
    "warns proactively when switching to a local model, before any message is sent — not just after a crash/failure",
    async () => {
      const localBaseUrl = await localServer.baseUrl;
      const events: WsEvent[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
      await waitFor(events, (e) => e.type === "session_info");

      ws.send(JSON.stringify({ type: "set_model", model: "local-only-model", family: "openai-compatible", baseUrl: localBaseUrl }));
      const warning = await waitFor(events, (e) => e.type === "system" && typeof e.text === "string" && e.text.includes("local model"));
      expect(warning.text).toContain("/tools");
      // No message was ever sent for this to fire on — it's proactive.
      expect(events.some((e) => e.type === "assistant_end")).toBe(false);

      // Real, reported annoyance: switching between several local models
      // in a row used to repeat the identical warning every single time.
      // A second switch to another local model on the SAME connection
      // must not fire it again.
      ws.send(JSON.stringify({ type: "set_model", model: "another-local-model", family: "openai-compatible", baseUrl: localBaseUrl }));
      await new Promise((r) => setTimeout(r, 500));
      const warnings = events.filter((e) => e.type === "system" && typeof e.text === "string" && e.text.includes("local model"));
      expect(warnings).toHaveLength(1);

      ws.close();
    },
    15_000,
  );

  it(
    "does not warn when switching to a normal (non-local) model",
    async () => {
      const events: WsEvent[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
      await waitFor(events, (e) => e.type === "session_info");

      ws.send(JSON.stringify({ type: "set_model", model: "default/laguna", family: "openai-compatible" }));
      await new Promise((r) => setTimeout(r, 500)); // give a would-be warning time to arrive
      expect(events.some((e) => e.type === "system" && typeof e.text === "string" && e.text.includes("local model"))).toBe(false);

      ws.close();
    },
    15_000,
  );

  it(
    "switching back to the default provider after an effort tier clears that tier's stale tool restriction",
    async () => {
      if (!(await isOllamaAvailable().catch(() => false))) return;
      if (!(await listOllamaModels().catch(() => [])).some((m) => m.name === "gemma2:2b")) return;

      const events: WsEvent[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
      await waitFor(events, (e) => e.type === "session_info");

      // Real, reported bug: after picking "low" (which disables every
      // tool), manually switching back to this project's normal default
      // provider through the plain model picker left every tool disabled —
      // stale state from the unrelated earlier tier pick.
      ws.send(JSON.stringify({ type: "set_effort", level: "low" }));
      await waitFor(events, (e) => e.type === "session_info" && e.effort === "low");
      const lowStatus = await waitFor(events, (e) => e.type === "tools_status");
      expect((lowStatus.tools as { enabled: boolean }[]).some((t) => t.enabled)).toBe(false);

      ws.send(JSON.stringify({ type: "set_model", model: "default/laguna", family: "openai-compatible" }));
      // events.find (inside waitFor) matches the FIRST event satisfying a
      // predicate, not the latest — "model === default/laguna" alone
      // would grab the initial connection's own session_info (that's this
      // project's default model too), sent before "low" was even applied.
      // Waiting for a SECOND tools_status event specifically sidesteps
      // that: the first is "low"'s (already captured above as lowStatus),
      // so a second one only exists once this switch-back actually sent
      // its own.
      const secondToolsStatus = await new Promise<WsEvent>((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          const matches = events.filter((e) => e.type === "tools_status");
          if (matches.length >= 2) return resolve(matches[1]!);
          if (Date.now() - start > 15_000) return reject(new Error(`timed out waiting for a 2nd tools_status: ${JSON.stringify(events)}`));
          setTimeout(check, 50);
        };
        check();
      });
      expect((secondToolsStatus.tools as { enabled: boolean }[]).some((t) => t.enabled)).toBe(true);

      ws.close();
    },
    20_000,
  );

  it(
    "a user_message sent immediately after set_effort (no wait, matching the real client) always lands on the new model, never the stale one",
    async () => {
      // Real, reported bug (reproduced directly with a real fake-provider
      // HTTP server logging which model name it actually received): this
      // server used to process each incoming WS message as an independent,
      // unserialized async handler. set_effort does real awaited work
      // (probing Ollama) before reassigning the connection's provider/
      // model — a user_message arriving during that window used to start
      // its turn immediately, silently using the OLD provider/model for
      // that one turn instead of waiting for the switch already in flight.
      if (!(await isOllamaAvailable().catch(() => false))) return;
      if (!(await listOllamaModels().catch(() => [])).some((m) => m.name === "gemma2:2b")) return;

      const events: WsEvent[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
      await waitFor(events, (e) => e.type === "session_info");

      const requestsToDefaultBefore = defaultServer.requestedModels().length;
      // Sent back-to-back, no await in between — mirrors the real client's
      // own "switch tier, then immediately send the first message" flow.
      ws.send(JSON.stringify({ type: "set_effort", level: "low" }));
      ws.send(JSON.stringify({ type: "user_message", text: "bonjour" }));

      await waitFor(events, (e) => e.type === "assistant_end", 240_000);

      // The real assertion: the default (fake-Poolside-like) server must
      // never have seen this turn at all — it should have gone entirely to
      // Ollama, since set_effort's switch must land before user_message's
      // turn starts, not race it.
      expect(defaultServer.requestedModels().length).toBe(requestsToDefaultBefore);
      const failed = events.some((e) => e.type === "system" && typeof e.text === "string" && e.text.includes("the model call failed"));
      expect(failed).toBe(false);

      ws.close();
    },
    250_000,
  );
});
