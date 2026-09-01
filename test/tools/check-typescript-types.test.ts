import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkTypescriptTypesTool } from "../../src/tools/builtin/check-typescript-types.js";

const TSC_TIMEOUT = 60_000;

describe("check_typescript_types tool (real tsc execution)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-tsc-test-"));
    await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022" } }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  it(
    "reports a clean pass for a type-correct project",
    async () => {
      await writeFile(path.join(dir, "good.ts"), "const x: number = 1;\nconsole.log(x);\n");
      const result = await checkTypescriptTypesTool.handler({}, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("exit code 0");
    },
    TSC_TIMEOUT,
  );

  it(
    "reports a real type error, without treating tsc's own exit code 1 as a tool failure",
    async () => {
      await writeFile(path.join(dir, "bad.ts"), 'const x: number = "not a number";\n');
      const result = await checkTypescriptTypesTool.handler({}, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("is not assignable to type");
    },
    TSC_TIMEOUT,
  );

  it("returns a clear error when there's no tsconfig.json, instead of dumping tsc's help text", async () => {
    await rm(path.join(dir, "tsconfig.json"));
    const result = await checkTypescriptTypesTool.handler({}, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No tsconfig.json found");
  });
});
