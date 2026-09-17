import { describe, expect, it, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundlePath = path.join(cliDir, "dist", "finanfa.js");

// Real, previously-shipped bug this project actually hit (found by
// actually running the globally-linked `finanfa` command from another
// directory, not by `npm run build` succeeding — tsup/esbuild only warns,
// never fails, when a dependency it bundled does something that breaks at
// runtime): tsup.config.ts's own `external` list had drifted out of sync
// with packages/core's real dependencies (missing every @opentelemetry/*
// package, among others). Once @opentelemetry/sdk-trace-node got bundled
// instead of staying external, its own internal `require("async_hooks")`
// broke under esbuild's ESM output format with "Dynamic require of
// 'async_hooks' is not supported" — a crash on every single invocation,
// not just when tracing is actually used, since it's imported at module
// load time. `npm run dev` (via tsx, real source, no bundling) never
// exercises this at all — this is the one test that actually runs the
// real compiled dist/finanfa.js in a real child process the way an
// end user's globally-installed `finanfa` command would.
describe("dist/finanfa.js (the real compiled bundle) runs without crashing", () => {
  beforeAll(() => {
    // npm run build must have already produced dist/finanfa.js.
    execFileSync("npm", ["run", "build"], { cwd: cliDir, stdio: "inherit" });
  }, 60_000);

  it("--help exits 0 and prints real usage, run from an unrelated cwd", async () => {
    const { stdout } = await execFileAsync(process.execPath, [bundlePath, "--help"], {
      cwd: path.dirname(cliDir), // deliberately NOT inside the project — a real user's shell could be anywhere
      env: { ...process.env },
    });
    expect(stdout).toContain("Usage: finanfa");
  }, 20_000);
});
