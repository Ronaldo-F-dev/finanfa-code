import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackgroundProcessManager } from "../../src/core/background-process.js";
import { createBackgroundProcessTools } from "../../src/tools/builtin/background-process.js";

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async (): Promise<void> => {
      if (await predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(() => void tick(), 20);
    };
    void tick();
  });
}

describe("background process tools", () => {
  let dir: string;
  let manager: BackgroundProcessManager;
  let start: ReturnType<typeof createBackgroundProcessTools>[0];
  let list: ReturnType<typeof createBackgroundProcessTools>[1];
  let stop: ReturnType<typeof createBackgroundProcessTools>[2];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-bgproc-tool-"));
    manager = new BackgroundProcessManager();
    [start, list, stop] = createBackgroundProcessTools(manager);
  });

  afterEach(async () => {
    manager.stopAll();
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("list_background_processes reports none initially", async () => {
    const result = await list.handler({}, ctx());
    expect(result.content).toBe("No background processes started this session.");
  });

  it("start_background_process starts a real process and it shows up in the list as running", async () => {
    const started = await start.handler({ name: "sleeper", command: "sleep 30" }, ctx());
    expect(started.isError).toBe(false);
    expect(started.content).toContain("sleeper");
    expect(started.content).toMatch(/PID \d+/);

    const listed = await list.handler({}, ctx());
    expect(listed.content).toContain("sleeper");
    expect(listed.content).toContain("running");
  });

  it("stop_background_process stops a tracked process by name", async () => {
    await start.handler({ name: "sleeper", command: "sleep 30" }, ctx());

    const stopped = await stop.handler({ name: "sleeper" }, ctx());
    expect(stopped.isError).toBe(false);
    expect(stopped.content).toBe('Stopped "sleeper".');

    const listed = await list.handler({}, ctx());
    expect(listed.content).toBe("No background processes started this session.");
  });

  it("stop_background_process errors clearly for an unknown name", async () => {
    const result = await stop.handler({ name: "nope" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No tracked background process named "nope"');
  });

  it("start_background_process errors clearly on a duplicate name instead of throwing", async () => {
    await start.handler({ name: "dup", command: "sleep 30" }, ctx());
    const second = await start.handler({ name: "dup", command: "sleep 30" }, ctx());
    expect(second.isError).toBe(true);
    expect(second.content).toContain("already tracked");
  });

  it("respects an absolute cwd, rejecting one outside the project root and home directory", async () => {
    await expect(
      start.handler({ name: "x", command: "sleep 1", cwd: "/etc" }, ctx()),
    ).rejects.toThrow(/outside the project root/);
  });

  it("a process that exits quickly disappears from the list on its own", async () => {
    await start.handler({ name: "quick", command: "true" }, ctx());
    await waitFor(async () => {
      const listed = await list.handler({}, ctx());
      return listed.content === "No background processes started this session.";
    });
    const finalListing = await list.handler({}, ctx());
    expect(finalListing.content).toBe("No background processes started this session.");
  });
});
