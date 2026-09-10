import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectTestCommand, runTestsTool } from "../../src/tools/builtin/run-tests.js";

describe("detectTestCommand", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-run-tests-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined when nothing is recognized", async () => {
    expect(await detectTestCommand(dir)).toBeUndefined();
  });

  it("picks npm test for a package.json with a real test script", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(await detectTestCommand(dir)).toBe("npm test");
  });

  it("ignores npm init's placeholder test script", async () => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    expect(await detectTestCommand(dir)).toBeUndefined();
  });

  it("prefers pnpm when a pnpm-lock.yaml is present", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "");
    expect(await detectTestCommand(dir)).toBe("pnpm test");
  });

  it("detects a Python project via pyproject.toml", async () => {
    await writeFile(path.join(dir, "pyproject.toml"), "[tool.pytest]\n");
    expect(await detectTestCommand(dir)).toBe("pytest");
  });

  it("detects a Rust project via Cargo.toml", async () => {
    await writeFile(path.join(dir, "Cargo.toml"), "[package]\n");
    expect(await detectTestCommand(dir)).toBe("cargo test");
  });

  it("detects a Go project via go.mod", async () => {
    await writeFile(path.join(dir, "go.mod"), "module example\n");
    expect(await detectTestCommand(dir)).toBe("go test ./...");
  });
});

describe("run_tests tool (real process execution)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-run-tests-exec-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  it("reports success for a passing detected test script", async () => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    const result = await runTestsTool.handler({}, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("exit code 0");
  });

  it("reports failure and surfaces stderr for a failing test script", async () => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "console.error(\'boom\'); process.exit(1)"' } }),
    );
    const result = await runTestsTool.handler({}, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom");
  });

  it("uses an explicit command override instead of auto-detection", async () => {
    const result = await runTestsTool.handler({ command: 'node -e "process.exit(0)"' }, ctx());
    expect(result.isError).toBe(false);
  });

  it("returns a clear error when no test command can be found", async () => {
    const result = await runTestsTool.handler({}, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No test command could be detected");
  });

  it(
    "real reported bug: Stop/interrupt (ctx.signal) actually kills a long-running test command instead of " +
      "having no effect until its own timeout",
    async () => {
      const controller = new AbortController();
      const runPromise = runTestsTool.handler(
        { command: "sleep 60", timeout_ms: 60_000 },
        { cwd: dir, sessionId: "test", signal: controller.signal },
      );
      await new Promise((r) => setTimeout(r, 200));
      const start = Date.now();
      controller.abort();
      const result = await runPromise;
      expect(Date.now() - start).toBeLessThan(5_000);
      expect(result.isError).toBe(true);
    },
    10_000,
  );
});
