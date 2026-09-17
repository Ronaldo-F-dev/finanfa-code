import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDebugPythonTracebackTool } from "../../src/tools/builtin/debug-python.js";

describe("debug_python_traceback (real python3 subprocess)", () => {
  const ctx = (cwd: string) => ({ cwd, sessionId: "s", signal: new AbortController().signal });

  it("runs a script that completes normally and reports success with its real stdout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-debug-py-"));
    try {
      await writeFile(path.join(dir, "ok.py"), "print('all good')\n");
      const tool = createDebugPythonTracebackTool();
      const result = await tool.handler({ script: "ok.py" }, ctx(dir));
      expect(result.isError).toBe(false);
      expect(result.content).toContain("all good");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("captures the real traceback AND the failing frame's local variables on an uncaught exception", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-debug-py-"));
    try {
      await writeFile(
        path.join(dir, "crash.py"),
        [
          "def divide(a, b):",
          "    denominator = b - 2",
          "    return a / denominator",
          "",
          "divide(10, 2)",
          "",
        ].join("\n"),
      );
      const tool = createDebugPythonTracebackTool();
      const result = await tool.handler({ script: "crash.py" }, ctx(dir));
      expect(result.isError).toBe(true);
      expect(result.content).toContain("ZeroDivisionError");
      expect(result.content).toContain("Local variables in the failing frame");
      // The real value of a variable at the point of failure, not just the line that failed.
      expect(result.content).toContain("a = 10");
      expect(result.content).toContain("denominator = 0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes through real script arguments as sys.argv", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-debug-py-"));
    try {
      await writeFile(path.join(dir, "echo_args.py"), "import sys\nprint(sys.argv[1:])\n");
      const tool = createDebugPythonTracebackTool();
      const result = await tool.handler({ script: "echo_args.py", args: ["hello", "world"] }, ctx(dir));
      expect(result.isError).toBe(false);
      expect(result.content).toContain("['hello', 'world']");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("has 'ask' risk level", () => {
    expect(createDebugPythonTracebackTool().riskLevel).toBe("ask");
  });
});
