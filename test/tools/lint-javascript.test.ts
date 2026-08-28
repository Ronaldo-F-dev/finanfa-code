import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lintJavascriptTool } from "../../src/tools/builtin/lint-javascript.js";

const ESLINT_TIMEOUT = 60_000;

describe("lint_javascript tool (real eslint execution)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-eslint-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  it("returns a clear error when no ESLint config is found, without invoking eslint at all", async () => {
    await writeFile(path.join(dir, "index.js"), "const x = 1;\n");
    const result = await lintJavascriptTool.handler({}, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No ESLint config found");
  });

  it(
    "reports a clean pass for a file with no lint errors",
    async () => {
      await writeFile(
        path.join(dir, "eslint.config.mjs"),
        "export default [{ rules: { 'no-cond-assign': 'error' } }];\n",
      );
      await writeFile(path.join(dir, "good.js"), "const x = 1;\nconsole.log(x);\n");

      const result = await lintJavascriptTool.handler({}, ctx());
      expect(result.isError).toBe(false);
    },
    ESLINT_TIMEOUT,
  );

  it(
    "reports a real lint error, without treating eslint's own exit code 1 as a tool failure",
    async () => {
      await writeFile(
        path.join(dir, "eslint.config.mjs"),
        "export default [{ rules: { 'no-cond-assign': 'error' } }];\n",
      );
      await writeFile(path.join(dir, "bad.js"), "let x = 1;\nif (x = 2) {\n  console.log(x);\n}\n");

      const result = await lintJavascriptTool.handler({}, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("no-cond-assign");
      expect(result.content).toContain("1 error");
    },
    ESLINT_TIMEOUT,
  );

  it(
    "checks only the given path when one is provided",
    async () => {
      await writeFile(
        path.join(dir, "eslint.config.mjs"),
        "export default [{ rules: { 'no-cond-assign': 'error' } }];\n",
      );
      await writeFile(path.join(dir, "bad.js"), "if (1 = 1) {}\n");
      await writeFile(path.join(dir, "good.js"), "const x = 1;\nconsole.log(x);\n");

      const result = await lintJavascriptTool.handler({ path: "good.js" }, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).not.toContain("bad.js");
    },
    ESLINT_TIMEOUT,
  );

  it("recognizes a legacy .eslintrc.json as a valid config too", async () => {
    await writeFile(path.join(dir, ".eslintrc.json"), JSON.stringify({ rules: {} }));
    await writeFile(path.join(dir, "index.js"), "const x = 1;\n");
    const result = await lintJavascriptTool.handler({}, ctx());
    // whether this specific legacy config actually works depends on which
    // eslint version npx resolves (v9+ needs flat config) — the point of
    // this test is just that config *detection* doesn't reject it outright
    expect(result.content).not.toContain("No ESLint config found");
  });

  it("rejects a path escaping the project root", async () => {
    await writeFile(path.join(dir, "eslint.config.mjs"), "export default [];\n");
    await expect(lintJavascriptTool.handler({ path: "../outside.js" }, ctx())).rejects.toThrow(
      /outside the project root/,
    );
  });
});
