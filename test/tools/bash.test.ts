import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bashTool } from "../../src/tools/builtin/bash.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("bash tool", () => {
  it("captures stdout and exit code for a successful command", async () => {
    const result = await bashTool.handler({ command: "echo hello" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("exit code 0");
    expect(result.content).toContain("hello");
  });

  it("reports a non-zero exit code as an error", async () => {
    const result = await bashTool.handler({ command: "exit 3" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("exit code 3");
  });

  it(
    "does not hang forever on a backgrounded, non-redirected child process — a real regression test",
    async () => {
      // Real bug: `server &` with no output redirection leaves an orphaned
      // process holding the inherited stdout pipe open, so plain
      // child.kill() on just the shell never lets Node's "close" event fire.
      // With process-group kill on timeout, this must resolve close to
      // timeout_ms, not anywhere near the 5s the backgrounded sleep would
      // otherwise keep the pipe open for.
      const started = Date.now();
      const result = await bashTool.handler(
        { command: "sleep 5 & echo done", timeout_ms: 300 },
        ctx,
      );
      const elapsed = Date.now() - started;

      expect(result.isError).toBe(true);
      expect(result.content).toContain("timed out");
      expect(elapsed).toBeLessThan(2000);
    },
    10_000,
  );

  it("a properly redirected/backgrounded process still lets the call return promptly", async () => {
    const started = Date.now();
    const result = await bashTool.handler(
      { command: "sleep 5 > /dev/null 2>&1 & echo done" },
      ctx,
    );
    const elapsed = Date.now() - started;

    expect(result.isError).toBe(false);
    expect(result.content).toContain("done");
    expect(elapsed).toBeLessThan(2000);
  });

  describe("uses bash, not the OS default /bin/sh (dash on Debian/Ubuntu)", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "finanfa-bash-shell-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("expands brace patterns ({a,b,c}) — real bug: dash creates one literal garbage path instead", async () => {
      // Reproduces the exact failure seen in a real session: dash doesn't
      // support brace expansion, so `mkdir -p project/{app,models}` created
      // a single directory literally named "{app,models}" instead of two.
      const result = await bashTool.handler(
        { command: "mkdir -p proj/{app,models,views} && echo done" },
        { ...ctx, cwd: dir },
      );
      expect(result.isError).toBe(false);

      const entries = await readdir(path.join(dir, "proj"));
      expect(entries.sort()).toEqual(["app", "models", "views"]);
    });

    it("reports itself as bash via $BASH_VERSION (unset under dash/sh)", async () => {
      const result = await bashTool.handler({ command: "echo v=$BASH_VERSION" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).not.toContain("v=\n");
    });
  });
});
