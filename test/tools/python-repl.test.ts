import { describe, expect, it, afterEach } from "vitest";
import { PythonReplManager } from "../../src/core/python-repl.js";
import { createPythonReplTool } from "../../src/tools/builtin/python-repl.js";

const TIMEOUT = 15_000;
const ctx = () => ({ cwd: "/tmp", sessionId: "test", signal: new AbortController().signal });

describe("python_repl tool", () => {
  let manager: PythonReplManager;

  afterEach(() => {
    manager?.reset();
  });

  it(
    "returns the trailing expression's value as content",
    async () => {
      manager = new PythonReplManager();
      const tool = createPythonReplTool(manager);
      const result = await tool.handler({ code: "1 + 1" }, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toBe("2");
    },
    TIMEOUT,
  );

  it(
    "state persists across separate tool calls",
    async () => {
      manager = new PythonReplManager();
      const tool = createPythonReplTool(manager);
      await tool.handler({ code: "x = 10" }, ctx());
      const result = await tool.handler({ code: "x + 5" }, ctx());
      expect(result.content).toBe("15");
    },
    TIMEOUT,
  );

  it(
    "marks a runtime error as isError and includes the traceback",
    async () => {
      manager = new PythonReplManager();
      const tool = createPythonReplTool(manager);
      const result = await tool.handler({ code: "1 / 0" }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("ZeroDivisionError");
    },
    TIMEOUT,
  );

  it(
    "reset: true clears the session before running new code",
    async () => {
      manager = new PythonReplManager();
      const tool = createPythonReplTool(manager);
      await tool.handler({ code: "x = 1" }, ctx());
      const result = await tool.handler({ code: "x", reset: true }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("NameError");
    },
    TIMEOUT,
  );

  it("reset: true with no code just resets and reports success", async () => {
    manager = new PythonReplManager();
    const tool = createPythonReplTool(manager);
    const result = await tool.handler({ reset: true }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("reset");
  });

  it("no code and no reset is an error", async () => {
    manager = new PythonReplManager();
    const tool = createPythonReplTool(manager);
    const result = await tool.handler({}, ctx());
    expect(result.isError).toBe(true);
  });

  it(
    "a timeout is reported as an error, distinct from a runtime exception",
    async () => {
      manager = new PythonReplManager();
      const tool = createPythonReplTool(manager);
      const result = await tool.handler({ code: "while True: pass", timeout_ms: 500 }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Timed out");
    },
    TIMEOUT,
  );
});
