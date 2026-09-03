import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackgroundProcessManager } from "../../src/core/background-process.js";

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

describe("BackgroundProcessManager (real process spawning)", () => {
  let dir: string;
  let manager: BackgroundProcessManager;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-bgproc-"));
    manager = new BackgroundProcessManager();
  });

  afterEach(async () => {
    manager.stopAll();
    await rm(dir, { recursive: true, force: true });
  });

  it("starts a process, tracks it as alive, and its output lands in the log file", async () => {
    const logFile = path.join(dir, "out.log");
    const info = manager.start("echoer", "echo hello-from-bg && sleep 5", dir, logFile);

    expect(info.name).toBe("echoer");
    expect(info.pid).toBeGreaterThan(0);
    expect(manager.isAlive(info.pid)).toBe(true);
    expect(manager.list()).toEqual([info]);

    await waitFor(async () => (await readFile(logFile, "utf-8").catch(() => "")).includes("hello-from-bg"));
    const logContent = await readFile(logFile, "utf-8");
    expect(logContent).toContain("hello-from-bg");
  });

  it("stop() kills the process and removes it from the registry", async () => {
    const logFile = path.join(dir, "out.log");
    const info = manager.start("sleeper", "sleep 30", dir, logFile);
    expect(manager.isAlive(info.pid)).toBe(true);

    const stopped = manager.stop("sleeper");
    expect(stopped).toBe(true);
    expect(manager.list()).toEqual([]);

    await waitFor(() => !manager.isAlive(info.pid));
  });

  it("stop() returns false for an unknown name", () => {
    expect(manager.stop("does-not-exist")).toBe(false);
  });

  it("rejects starting a second process under a name already in use", () => {
    const logFile = path.join(dir, "out.log");
    manager.start("dup", "sleep 30", dir, logFile);
    expect(() => manager.start("dup", "sleep 30", dir, logFile)).toThrow(/already tracked/);
  });

  it("removes an entry from the registry once the process exits on its own", async () => {
    const logFile = path.join(dir, "out.log");
    manager.start("quick", "true", dir, logFile);

    await waitFor(() => manager.list().length === 0);
    expect(manager.list()).toEqual([]);
  });

  it("stopAll() stops every tracked process", async () => {
    const logFile1 = path.join(dir, "out1.log");
    const logFile2 = path.join(dir, "out2.log");
    const a = manager.start("a", "sleep 30", dir, logFile1);
    const b = manager.start("b", "sleep 30", dir, logFile2);

    manager.stopAll();

    expect(manager.list()).toEqual([]);
    await waitFor(() => !manager.isAlive(a.pid) && !manager.isAlive(b.pid));
  });
});
