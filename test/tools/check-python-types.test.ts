import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkPythonTypesTool } from "../../src/tools/builtin/check-python-types.js";

const PYRIGHT_TIMEOUT = 30_000;

describe("check_python_types tool (real pyright execution)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-pyright-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  it(
    "reports a clean pass for a type-correct file",
    async () => {
      await writeFile(
        path.join(dir, "good.py"),
        "def add(a: int, b: int) -> int:\n    return a + b\n\nresult: int = add(1, 2)\n",
      );
      const result = await checkPythonTypesTool.handler({}, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("0 errors");
    },
    PYRIGHT_TIMEOUT,
  );

  it(
    "reports a real type error, without treating pyright's own nonzero exit as a tool failure",
    async () => {
      await writeFile(
        path.join(dir, "bad.py"),
        "def add(a: int, b: int) -> int:\n    return a + b\n\nresult: str = add(1, 2)\n",
      );
      const result = await checkPythonTypesTool.handler({}, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("is not assignable to declared type");
      expect(result.content).toContain("1 error");
    },
    PYRIGHT_TIMEOUT,
  );

  it(
    "checks only the given path when one is provided",
    async () => {
      await writeFile(path.join(dir, "bad.py"), "result: str = 1\n");
      await writeFile(path.join(dir, "good.py"), "result: int = 1\n");
      const result = await checkPythonTypesTool.handler({ path: "good.py" }, ctx());
      expect(result.content).toContain("0 errors");
      expect(result.content).not.toContain("bad.py");
    },
    PYRIGHT_TIMEOUT,
  );

  it("returns a clear error when no Python project is detected", async () => {
    const result = await checkPythonTypesTool.handler({}, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No Python project detected");
  });

  it("rejects a path escaping the project root", async () => {
    await writeFile(path.join(dir, "good.py"), "x: int = 1\n");
    await expect(checkPythonTypesTool.handler({ path: "../outside.py" }, ctx())).rejects.toThrow(
      /outside the project root/,
    );
  });
});
