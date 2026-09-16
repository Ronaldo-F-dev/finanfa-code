import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end check that .finanfa-code/plugins/<name>/index.js loads in
// the web server the same way it already does in the CLI (cli.ts calls
// loadPlugins too) — until this test existed, the web UI silently ignored
// every project's plugins because index.ts never called loadPlugins at all.
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

describe("web-server plugin loading (real subprocess, real WebSocket)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let baselineToolCount: number;

  beforeAll(async () => {
    // First measure the tool count with no plugin at all, so the
    // assertion below is "+1 from the plugin" rather than a brittle
    // hardcoded absolute count that'd drift as builtins are added/removed.
    const baselineProjectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-plugins-baseline-"));
    const baselineHomeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-plugins-baseline-home-"));
    const baseline = await spawnWebServer(baselineProjectDir, baselineHomeDir, 4950);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${baseline.port}/ws`);
      const events: WsEvent[] = [];
      ws.on("message", (data) => events.push(JSON.parse(data.toString())));
      await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });
      const info = await waitFor(events, (e) => e.type === "session_info");
      baselineToolCount = info.toolCount as number;
      ws.close();
    } finally {
      killWebServer(baseline.child);
      await rm(baselineProjectDir, { recursive: true, force: true });
      await rm(baselineHomeDir, { recursive: true, force: true });
    }

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-plugins-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-plugins-home-"));

    const pluginDir = path.join(projectDir, ".finanfa-code", "plugins", "greet");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, "index.js"),
      `export function registerTools(registry) {
        registry.register({
          name: "greet",
          description: "Says hello",
          riskLevel: "safe",
          inputSchema: { type: "object" },
          async handler() { return { content: "hello from plugin", isError: false }; },
        });
      }`,
    );

    ({ child, port } = await spawnWebServer(projectDir, homeDir, 4950));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("registers a project's plugin tools, reflected in session_info's toolCount, once the folder is trusted", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events: WsEvent[] = [];
    ws.on("message", (data) => events.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    // A plugins directory is one of the things the folder-trust gate
    // covers (see core/trust-gate.ts) — same as an untrusted
    // .finanfa-code/settings.json, the plugin must not load before the
    // user actually agrees to trust this folder.
    const trustAsk = await waitFor(events, (e) => e.type === "ask" && e.kind === "confirm");
    ws.send(JSON.stringify({ type: "permission_response", requestId: trustAsk.requestId, answer: "y" }));

    const info = await waitFor(events, (e) => e.type === "session_info");
    expect(info.toolCount).toBe(baselineToolCount + 1);

    ws.close();
  });
});
