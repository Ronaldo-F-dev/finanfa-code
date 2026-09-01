import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lintPythonTool } from "../../src/tools/builtin/lint-python.js";

const RUFF_TIMEOUT = 60_000;

describe("lint_python tool (real ruff execution via uvx)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-ruff-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  it(
    "reports a clean pass for a file with no lint issues",
    async () => {
      await writeFile(path.join(dir, "good.py"), "def add(a: int, b: int) -> int:\n    return a + b\n");
      const result = await lintPythonTool.handler({}, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("exit code 0");
    },
    RUFF_TIMEOUT,
  );

  it(
    "reports real lint findings, without treating ruff's own exit code 1 as a tool failure",
    async () => {
      await writeFile(path.join(dir, "bad.py"), "import os\nx=1\n");
      const result = await lintPythonTool.handler({}, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("imported but unused");
    },
    RUFF_TIMEOUT,
  );

  it(
    "checks only the given path when one is provided",
    async () => {
      await writeFile(path.join(dir, "bad.py"), "import os\nx=1\n");
      await writeFile(path.join(dir, "good.py"), "x = 1\n");
      const result = await lintPythonTool.handler({ path: "good.py" }, ctx());
      expect(result.content).toContain("exit code 0");
      expect(result.content).not.toContain("bad.py");
    },
    RUFF_TIMEOUT,
  );

  it("returns a clear error when no Python project is detected", async () => {
    const result = await lintPythonTool.handler({}, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No Python project detected");
  });

  it("rejects a path escaping the project root", async () => {
    await writeFile(path.join(dir, "good.py"), "x = 1\n");
    await expect(lintPythonTool.handler({ path: "../outside.py" }, ctx())).rejects.toThrow(
      /outside the project root/,
    );
  });
});
