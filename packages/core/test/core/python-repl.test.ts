import { describe, expect, it, afterEach } from "vitest";
import { PythonReplManager } from "../../src/core/python-repl.js";

const TIMEOUT = 15_000;
const CWD = process.cwd();
const SESSION_ID = "test-session";

describe("PythonReplManager (real python3 subprocess)", () => {
  let manager: PythonReplManager;

  afterEach(() => {
    manager?.reset();
  });

  it(
    "persists variables across separate run() calls",
    async () => {
      manager = new PythonReplManager();
      await manager.run("x = 5", 5000, CWD, SESSION_ID);
      const result = await manager.run("x * 2", 5000, CWD, SESSION_ID);
      expect(result.result).toBe("10");
      expect(result.error).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "captures print() output separately from the trailing expression's value",
    async () => {
      manager = new PythonReplManager();
      const result = await manager.run("print('hello'); y = 41 + 1\ny", 5000, CWD, SESSION_ID);
      expect(result.stdout).toBe("hello\n");
      expect(result.result).toBe("42");
    },
    TIMEOUT,
  );

  it(
    "captures the return value of a multi-statement block ending in an expression",
    async () => {
      manager = new PythonReplManager();
      const result = await manager.run("def f():\n    return 42\nf()", 5000, CWD, SESSION_ID);
      expect(result.result).toBe("42");
    },
    TIMEOUT,
  );

  it(
    "returns a traceback in error, without throwing, for a runtime exception",
    async () => {
      manager = new PythonReplManager();
      const result = await manager.run("1 / 0", 5000, CWD, SESSION_ID);
      expect(result.error).toContain("ZeroDivisionError");
      // the session itself is still usable after an error
      const after = await manager.run("2 + 2", 5000, CWD, SESSION_ID);
      expect(after.result).toBe("4");
    },
    TIMEOUT,
  );

  it(
    "survives sys.exit() instead of the whole process dying",
    async () => {
      manager = new PythonReplManager();
      await manager.run("x = 99", 5000, CWD, SESSION_ID);
      const exitResult = await manager.run("import sys; sys.exit(1)", 5000, CWD, SESSION_ID);
      expect(exitResult.error).toContain("SystemExit");

      const after = await manager.run("x", 5000, CWD, SESSION_ID);
      expect(after.result).toBe("99");
    },
    TIMEOUT,
  );

  it(
    "reset() clears all session state",
    async () => {
      manager = new PythonReplManager();
      await manager.run("x = 1", 5000, CWD, SESSION_ID);
      manager.reset();
      const result = await manager.run("x", 5000, CWD, SESSION_ID);
      expect(result.error).toContain("NameError");
    },
    TIMEOUT,
  );

  it(
    "kills a hung process on timeout, and the next call transparently starts fresh",
    async () => {
      manager = new PythonReplManager();
      await manager.run("x = 1", 5000, CWD, SESSION_ID);
      const hung = await manager.run("while True: pass", 500, CWD, SESSION_ID);
      expect(hung.timedOut).toBe(true);

      // state is gone — the old process was killed, a new one starts on the next call
      const after = await manager.run("x", 5000, CWD, SESSION_ID);
      expect(after.error).toContain("NameError");
    },
    TIMEOUT,
  );

  it(
    "real reported bug: Stop/interrupt while python_repl is running a long/hung command actually kills it, " +
      "instead of doing nothing until reload — the same abort signal bash already respects",
    async () => {
      manager = new PythonReplManager();
      await manager.run("x = 1", 5000, CWD, SESSION_ID);

      const controller = new AbortController();
      const runPromise = manager.run("while True: pass", 60_000, CWD, SESSION_ID, controller.signal);
      // Give the child process a moment to actually start before aborting —
      // this is the real "user clicks Stop mid-execution" scenario, not an
      // abort that races the subprocess spawn itself.
      await new Promise((r) => setTimeout(r, 200));
      controller.abort();

      const result = await runPromise;
      expect(result.interrupted).toBe(true);
      expect(result.timedOut).toBeFalsy();

      // Same as a timeout: state is gone, but the session is usable again
      // immediately on the next call, not stuck.
      const after = await manager.run("x", 5000, CWD, SESSION_ID);
      expect(after.error).toContain("NameError");
    },
    TIMEOUT,
  );

  it(
    "an already-aborted signal is honored immediately, without ever starting the command",
    async () => {
      manager = new PythonReplManager();
      const controller = new AbortController();
      controller.abort();

      const result = await manager.run("1 + 1", 5000, CWD, SESSION_ID, controller.signal);
      expect(result.interrupted).toBe(true);
      expect(result.result).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "handles many sequential calls correctly (regression: a per-call listener that never" +
      " unregistered would misfire on later calls)",
    async () => {
      manager = new PythonReplManager();
      for (let i = 0; i < 10; i++) {
        const result = await manager.run(`${i} * 2`, 5000, CWD, SESSION_ID);
        expect(result.result).toBe(String(i * 2));
      }
    },
    TIMEOUT,
  );
});
