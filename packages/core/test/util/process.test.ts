import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { killProcessGroup, runSubprocess } from "../../src/util/process.js";

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => child.on("exit", () => resolve()));
}

describe("killProcessGroup", () => {
  it("kills a detached process group, including a backgrounded grandchild", async () => {
    // The shell backgrounds a long-running sleep and exits almost
    // immediately — without group-kill, that orphaned sleep would keep
    // running (and, in the real bash tool, keep an inherited stdio pipe open).
    const child = spawn("sh", ["-c", "sleep 30 & echo $!"], { detached: true });
    let backgroundPid = "";
    child.stdout?.on("data", (d) => (backgroundPid += d));
    await waitForExit(child);

    const pid = Number(backgroundPid.trim());
    expect(Number.isNaN(pid)).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow(); // still alive

    killProcessGroup(child);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(() => process.kill(pid, 0)).toThrow(); // gone
  });

  it("does not throw when the process already exited", async () => {
    const child = spawn("true", [], { detached: true });
    await waitForExit(child);
    expect(() => killProcessGroup(child)).not.toThrow();
  });

  it("does not throw when pid is missing (spawn failed)", () => {
    const fakeChild = { pid: undefined, kill: () => true } as unknown as ReturnType<typeof spawn>;
    expect(() => killProcessGroup(fakeChild)).not.toThrow();
  });
});

describe("runSubprocess (shared by bash/run_tests/check_python_types/lint_javascript)", () => {
  it("as a raw shell command (no args), captures stdout and a zero exit code", async () => {
    const result = await runSubprocess("echo hello", { cwd: process.cwd(), sessionId: "test", timeoutMs: 5000 });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("exit code 0");
    expect(result.content).toContain("hello");
  });

  it("as a program + args (no shell string), still runs correctly", async () => {
    const result = await runSubprocess("echo", { args: ["hello-args"], cwd: process.cwd(), sessionId: "test", timeoutMs: 5000 });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello-args");
  });

  it("default isError treats any nonzero exit as failure", async () => {
    const result = await runSubprocess("exit 1", { cwd: process.cwd(), sessionId: "test", timeoutMs: 5000 });
    expect(result.isError).toBe(true);
  });

  it("a custom isError predicate can treat a nonzero exit as success (e.g. pyright/eslint's exit 1 = findings)", async () => {
    const result = await runSubprocess("exit 1", { cwd: process.cwd(), sessionId: "test", timeoutMs: 5000, isError: (code) => code !== 0 && code !== 1 });
    expect(result.isError).toBe(false);
  });

  it('format "labeled" always shows both stdout/stderr sections, even empty', async () => {
    const result = await runSubprocess("true", { cwd: process.cwd(), sessionId: "test", timeoutMs: 5000, format: "labeled" });
    expect(result.content).toContain("--- stdout ---");
    expect(result.content).toContain("--- stderr ---");
  });

  it('format "compact" omits the stderr section entirely when there is no stderr output', async () => {
    const result = await runSubprocess("echo only-stdout", { cwd: process.cwd(), sessionId: "test", timeoutMs: 5000, format: "compact" });
    expect(result.content).not.toContain("--- stdout ---");
    expect(result.content).not.toContain("--- stderr ---");
  });

  it("kills a backgrounded, non-redirected child on timeout instead of hanging forever", async () => {
    const start = Date.now();
    const result = await runSubprocess("sleep 5 & echo done", { cwd: process.cwd(), sessionId: "test", timeoutMs: 300 });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  });

  it("aborting mid-run cancels the result and kills a backgrounded grandchild too, not just the immediate shell", async () => {
    // The real bug this covers: opts.signal used to be passed straight to
    // spawn()'s own `signal` option, which only kills the immediate child —
    // a background job started *inside* the shell command (exactly what
    // interrupting a real bash tool call mid-way looks like) would survive
    // as an orphan. Regression test, not just a unit check: verifies the
    // grandchild's real PID is actually dead after abort, the same way
    // killProcessGroup's own test above does.
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-abort-test-"));
    const pidFile = path.join(dir, "pid.txt");
    try {
      const controller = new AbortController();
      const promise = runSubprocess(`sleep 30 & echo $! > ${pidFile}; wait`, {
        cwd: process.cwd(), sessionId: "test",
        timeoutMs: 10_000,
        signal: controller.signal,
      });

      await waitUntil(async () => (await readFile(pidFile, "utf-8").catch(() => "")).trim().length > 0);
      const pid = Number((await readFile(pidFile, "utf-8")).trim());
      expect(() => process.kill(pid, 0)).not.toThrow(); // the backgrounded sleep is genuinely alive

      controller.abort();
      const result = await promise;

      expect(result.isError).toBe(true);
      expect(result.content).toContain("cancelled");
      await new Promise((r) => setTimeout(r, 300));
      expect(() => process.kill(pid, 0)).toThrow(); // the grandchild is genuinely dead, not orphaned
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a command not found on PATH is a normal nonzero exit (127), not a spawn-level error — everything goes through the shell", async () => {
    const result = await runSubprocess("this-binary-does-not-exist-xyz", { cwd: process.cwd(), sessionId: "test", timeoutMs: 5000 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("exit code 127");
  });

  it("reports a clean error when spawn itself can't start (e.g. cwd doesn't exist)", async () => {
    const result = await runSubprocess("echo hi", { cwd: "/nonexistent-dir-xyz", sessionId: "test", timeoutMs: 5000 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Failed to start");
  });

  it(
    "spills stdout over TRUNCATE_LARGE to a real file on disk instead of dropping it, and the preview still " +
      "shows the exit code and stderr section",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "finanfa-spill-proc-"));
      try {
        // node -e prints 150,000 'a's — comfortably over TRUNCATE_LARGE (100,000).
        const result = await runSubprocess('node -e "process.stdout.write(\'a\'.repeat(150000))"', {
          cwd: dir,
          sessionId: "spill-test",
          timeoutMs: 10_000,
        });

        expect(result.isError).toBe(false);
        expect(result.content).toContain("exit code 0");
        expect(result.content).toContain("--- stderr ---");
        expect(result.content).toContain("saved to .finanfa-code/spill/spill-test/stdout-");

        const relPathMatch = result.content.match(/saved to (\S+);/);
        expect(relPathMatch).not.toBeNull();
        const onDisk = await readFile(path.join(dir, relPathMatch![1]), "utf-8");
        expect(onDisk).toBe("a".repeat(150_000)); // the full, untruncated stdout
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
