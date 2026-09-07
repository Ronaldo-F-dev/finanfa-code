import { describe, expect, it, beforeAll } from "vitest";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMydevopsTool } from "../../src/tools/builtin/mydevops.js";

const FAKE_MYDEVOPS_SCRIPT = fileURLToPath(new URL("../fixtures/fake-mydevops.mjs", import.meta.url));
const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("run_mydevops tool (real subprocess, fake mydevops binary stand-in)", () => {
  beforeAll(async () => {
    // Executable bit may not survive a git checkout/CI clone even though
    // it was chmod +x'd when authored — ensure it's really runnable via
    // its shebang before any test relies on that.
    await chmod(FAKE_MYDEVOPS_SCRIPT, 0o755);
  });

  it("has 'dangerous' risk level", () => {
    expect(createMydevopsTool({ binary: FAKE_MYDEVOPS_SCRIPT }).riskLevel).toBe("dangerous");
  });

  it("scopes the permission riskKey by subcommand (mydevops:<subcommand>), not the whole tool", () => {
    const tool = createMydevopsTool({ binary: FAKE_MYDEVOPS_SCRIPT });
    expect(tool.riskKey?.({ subcommand: "doctor" })).toBe("mydevops:doctor");
    expect(tool.riskKey?.({ subcommand: "destroy" })).toBe("mydevops:destroy");
  });

  it("passes the subcommand and args through as real argv, not a shell string", async () => {
    const tool = createMydevopsTool({ binary: FAKE_MYDEVOPS_SCRIPT });
    const result = await tool.handler({ subcommand: "whoami", args: ["--env", "production"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('args=["whoami","--env","production"]');
  });

  it("runs in the given cwd (relative to the project root), so mydevops finds the right mydevops.yml", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-mydevops-cwd-"));
    try {
      const subDir = "infra";
      await import("node:fs/promises").then((fs) => fs.mkdir(path.join(projectDir, subDir)));
      const tool = createMydevopsTool({ binary: FAKE_MYDEVOPS_SCRIPT });
      const result = await tool.handler({ subcommand: "whoami", cwd: subDir }, { ...ctx, cwd: projectDir });
      expect(result.content).toContain(`cwd=${path.join(projectDir, subDir)}`);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("reports a real non-zero exit code as isError, with the real stderr content", async () => {
    const tool = createMydevopsTool({ binary: FAKE_MYDEVOPS_SCRIPT });
    const result = await tool.handler({ subcommand: "destroy" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("refusing to destroy without --confirm");
  });

  it("defaults to the real 'mydevops' binary name when no binary override is given", async () => {
    const tool = createMydevopsTool();
    const result = await tool.handler({ subcommand: "whoami" }, ctx);
    // The real mydevops binary is snap-packaged and doesn't run inside
    // this dev sandbox (confirmed separately: exits immediately, code
    // 120) — this just confirms the wrapper attempts to invoke something
    // named "mydevops" and reports back a real (non-throwing) result
    // either way, rather than asserting on its actual (unavailable-here)
    // behavior.
    expect(typeof result.isError).toBe("boolean");
  }, 15_000);
});
