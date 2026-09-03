import { describe, expect, it, afterEach } from "vitest";
import { PythonReplManager } from "../../src/core/python-repl.js";

const TIMEOUT = 15_000;

describe("PythonReplManager (real python3 subprocess)", () => {
  let manager: PythonReplManager;

  afterEach(() => {
    manager?.reset();
  });

  it(
    "persists variables across separate run() calls",
    async () => {
      manager = new PythonReplManager();
      await manager.run("x = 5", 5000);
      const result = await manager.run("x * 2", 5000);
      expect(result.result).toBe("10");
      expect(result.error).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "captures print() output separately from the trailing expression's value",
    async () => {
      manager = new PythonReplManager();
      const result = await manager.run("print('hello'); y = 41 + 1\ny", 5000);
      expect(result.stdout).toBe("hello\n");
      expect(result.result).toBe("42");
    },
    TIMEOUT,
  );

  it(
    "captures the return value of a multi-statement block ending in an expression",
    async () => {
      manager = new PythonReplManager();
      const result = await manager.run("def f():\n    return 42\nf()", 5000);
      expect(result.result).toBe("42");
    },
    TIMEOUT,
  );

  it(
    "returns a traceback in error, without throwing, for a runtime exception",
    async () => {
      manager = new PythonReplManager();
      const result = await manager.run("1 / 0", 5000);
      expect(result.error).toContain("ZeroDivisionError");
      // the session itself is still usable after an error
      const after = await manager.run("2 + 2", 5000);
      expect(after.result).toBe("4");
    },
    TIMEOUT,
  );

  it(
    "survives sys.exit() instead of the whole process dying",
    async () => {
      manager = new PythonReplManager();
      await manager.run("x = 99", 5000);
      const exitResult = await manager.run("import sys; sys.exit(1)", 5000);
      expect(exitResult.error).toContain("SystemExit");

      const after = await manager.run("x", 5000);
      expect(after.result).toBe("99");
    },
    TIMEOUT,
  );

  it(
    "reset() clears all session state",
    async () => {
      manager = new PythonReplManager();
      await manager.run("x = 1", 5000);
      manager.reset();
      const result = await manager.run("x", 5000);
      expect(result.error).toContain("NameError");
    },
    TIMEOUT,
  );

  it(
    "kills a hung process on timeout, and the next call transparently starts fresh",
    async () => {
      manager = new PythonReplManager();
      await manager.run("x = 1", 5000);
      const hung = await manager.run("while True: pass", 500);
      expect(hung.timedOut).toBe(true);

      // state is gone — the old process was killed, a new one starts on the next call
      const after = await manager.run("x", 5000);
      expect(after.error).toContain("NameError");
    },
    TIMEOUT,
  );

  it(
    "handles many sequential calls correctly (regression: a per-call listener that never" +
      " unregistered would misfire on later calls)",
    async () => {
      manager = new PythonReplManager();
      for (let i = 0; i < 10; i++) {
        const result = await manager.run(`${i} * 2`, 5000);
        expect(result.result).toBe(String(i * 2));
      }
    },
    TIMEOUT,
  );
});
