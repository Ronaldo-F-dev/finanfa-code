import { afterEach, describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { killWebServer, spawnWebServer } from "./support/spawn-server.js";

// The desktop app starts this server as a child and sets FINANFA_PARENT_PID. If the app dies without
// getting to stop it (a crash, a force-quit), the server must not stay up with its port and its agent.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid!;
  await new Promise((r) => child.on("exit", r));
  return pid;
}

function exited(child: ChildProcessWithoutNullStreams, withinMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), withinMs);
    child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

async function start(extraEnv: NodeJS.ProcessEnv) {
  const projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-parent-project-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-parent-home-"));
  const started = await spawnWebServer(projectDir, homeDir, extraEnv);
  cleanups.push(() => killWebServer(started.child));
  cleanups.push(() => rm(projectDir, { recursive: true, force: true }));
  cleanups.push(() => rm(homeDir, { recursive: true, force: true }));
  return started;
}

describe("FINANFA_PARENT_PID watchdog", () => {
  it("exits by itself once its parent process is gone", async () => {
    const { child } = await start({ FINANFA_PARENT_PID: String(await deadPid()) });
    expect(await exited(child, 8000)).toBe(true);
  }, 30_000);

  it("keeps running while the parent is alive", async () => {
    const { child, port } = await start({ FINANFA_PARENT_PID: String(process.pid) });
    expect(await exited(child, 4500)).toBe(false);
    expect((await fetch(`http://127.0.0.1:${port}/api/projects`)).status).toBe(200);
  }, 30_000);

  it("ignores a missing or nonsensical value", async () => {
    const { child } = await start({ FINANFA_PARENT_PID: "not-a-pid" });
    expect(await exited(child, 4500)).toBe(false);
  }, 30_000);
});
