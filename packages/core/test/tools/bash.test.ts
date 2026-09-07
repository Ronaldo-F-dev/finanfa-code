import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBashTool } from "../../src/tools/builtin/bash.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

// These regression tests exercise the pre-sandbox invariants (bash vs dash,
// process-group kill on timeout/backgrounding) in isolation from the new
// sandbox layer — explicitly unsandboxed, so a bwrap quirk can't be
// confused with a regression in the underlying spawn/kill logic. Sandboxed
// behavior itself is covered in its own describe block below.
const bashTool = createBashTool({ mode: "off" });

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

describe("bash tool — OS-level sandbox (real bubblewrap, workspace-write mode)", () => {
  const sandboxedTool = createBashTool({ mode: "workspace-write" });
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-bash-sandbox-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults to sandboxed when no sandbox config is passed at all", async () => {
    // createBashTool() with zero args must behave exactly like {mode:
    // "workspace-write"} — the actual default this feature exists for.
    const defaultTool = createBashTool();
    expect(defaultTool.description).toContain("OS-level sandbox");
  });

  it("can still write inside its own cwd", async () => {
    const result = await sandboxedTool.handler({ command: "echo inside > file.txt && cat file.txt" }, { ...ctx, cwd: dir });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("inside");
  });

  it("cannot write anywhere outside its cwd — the whole point of the sandbox", async () => {
    const result = await sandboxedTool.handler({ command: "touch /etc/finanfa-sandbox-test-should-fail" }, { ...ctx, cwd: dir });
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("read-only file system");
  });

  it("cannot write into an unrelated directory it wasn't given (outside /tmp, which stays writable everywhere — see sandbox.ts)", async () => {
    // Deliberately NOT under os.tmpdir(): buildBwrapArgs binds all of /tmp
    // read-write (for cross-call scratch-file persistence, matching today's
    // unsandboxed behavior), so a sibling under /tmp wouldn't prove
    // anything here — /var/tmp is a real, distinct system directory
    // covered only by the read-only root bind.
    const result = await sandboxedTool.handler({ command: "touch /var/tmp/finanfa-sandbox-test-should-fail" }, { ...ctx, cwd: dir });
    expect(result.isError).toBe(true);
  });

  it("can still read files outside its cwd (read-only bind of the whole filesystem)", async () => {
    const result = await sandboxedTool.handler({ command: "cat /etc/hostname" }, { ...ctx, cwd: dir });
    expect(result.isError).toBe(false);
  });

  it("still has network access (workspace-write doesn't isolate the network namespace)", async () => {
    const result = await sandboxedTool.handler({ command: "getent hosts localhost" }, { ...ctx, cwd: dir });
    expect(result.isError).toBe(false);
  });

  it("still kills a backgrounded, non-redirected grandchild on timeout (process-group kill reaches inside the sandbox)", async () => {
    const started = Date.now();
    const result = await sandboxedTool.handler({ command: "sleep 5 & echo done", timeout_ms: 300 }, { ...ctx, cwd: dir });
    const elapsed = Date.now() - started;

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
    expect(elapsed).toBeLessThan(2000);
  }, 10_000);

  it("{mode: 'off'} stays fully unsandboxed even when bwrap is available — can write outside cwd", async () => {
    const offTool = createBashTool({ mode: "off" });
    const target = path.join(tmpdir(), `finanfa-sandbox-off-test-${Date.now()}`);
    try {
      const result = await offTool.handler({ command: `touch ${target}` }, { ...ctx, cwd: dir });
      expect(result.isError).toBe(false);
    } finally {
      await rm(target, { force: true });
    }
  });
});
