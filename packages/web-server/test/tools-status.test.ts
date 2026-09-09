import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the "Tools" management round trip the web
// client's new panel drives: list every registered tool with its
// enabled/disabled state, toggle one, and see it reflected — the direct,
// immediate fix for a real reported problem (a small-context local model
// overflowing on this project's system prompt + full tool list before a
// single user message is even added): disabling most tools from the
// browser is what makes that recoverable without dropping to the CLI's
// /tools command.
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

/** Waits for the Nth "tools_status" event specifically (1-indexed) — plain waitFor can't express "the 2nd one", since its predicate only sees one event at a time. */
function waitForNthToolsStatus(events: WsEvent[], n: number, timeoutMs = 10_000): Promise<WsEvent> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const matches = events.filter((e) => e.type === "tools_status");
      if (matches.length >= n) return resolve(matches[n - 1]!);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for tools_status #${n}: ${JSON.stringify(events)}`));
      setTimeout(check, 50);
    };
    check();
  });
}

describe("web-server tools_status / set_tool_enabled (real subprocess, real WebSocket)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-tools-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-tools-home-"));
    ({ child, port } = await spawnWebServer(projectDir, homeDir, 4900));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  async function connect(): Promise<{ ws: WebSocket; events: WsEvent[] }> {
    const events: WsEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
    // Real clients only ever send a message in response to a user action —
    // by which point the server's own connection setup (which sends
    // session_info before its own message listener is even attached — see
    // handleConnection in index.ts) has long since finished. A test client
    // sending immediately on "open" doesn't have that natural delay and can
    // race the server's message listener, silently dropping the send —
    // waiting for the first real event (session_info) before sending
    // anything mirrors what an actual client's timing looks like.
    await waitFor(events, (e) => e.type === "session_info");
    return { ws, events };
  }

  it(
    "responds to tools_status with every registered tool, all enabled by default",
    async () => {
      const { ws, events } = await connect();
      try {
        ws.send(JSON.stringify({ type: "tools_status" }));
        const status = await waitFor(events, (e) => e.type === "tools_status");
        const list = status.tools as { name: string; riskLevel: string; enabled: boolean }[];
        expect(list.length).toBeGreaterThan(50); // this project genuinely registers 90+ builtin tools
        expect(list.every((t) => t.enabled)).toBe(true);
        expect(list.some((t) => t.name === "bash" && t.riskLevel === "dangerous")).toBe(true);
      } finally {
        ws.close();
      }
    },
    15_000,
  );

  it(
    "set_tool_enabled:false disables a tool and is reflected in the next tools_status",
    async () => {
      const { ws, events } = await connect();
      try {
        ws.send(JSON.stringify({ type: "set_tool_enabled", name: "bash", enabled: false }));
        const status = await waitFor(events, (e) => e.type === "tools_status");
        const bash = (status.tools as { name: string; enabled: boolean }[]).find((t) => t.name === "bash");
        expect(bash?.enabled).toBe(false);
      } finally {
        ws.close();
      }
    },
    15_000,
  );

  it(
    "set_tool_enabled:true re-enables it",
    async () => {
      const { ws, events } = await connect();
      try {
        ws.send(JSON.stringify({ type: "set_tool_enabled", name: "bash", enabled: false }));
        await waitForNthToolsStatus(events, 1);
        ws.send(JSON.stringify({ type: "set_tool_enabled", name: "bash", enabled: true }));
        const secondStatus = await waitForNthToolsStatus(events, 2);
        const bash = (secondStatus.tools as { name: string; enabled: boolean }[]).find((t) => t.name === "bash");
        expect(bash?.enabled).toBe(true);
      } finally {
        ws.close();
      }
    },
    15_000,
  );
});
