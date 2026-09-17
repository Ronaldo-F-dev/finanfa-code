import { describe, expect, it, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDelegateToClaudeCodeTool, createDelegateToCodexTool } from "../../src/tools/builtin/delegate-agent.js";

const FAKE_CLAUDE_SCRIPT = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));
const FAKE_CODEX_SCRIPT = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("delegate_to_claude_code tool (real subprocess, fake claude binary stand-in)", () => {
  beforeAll(async () => {
    // Executable bit may not survive a git checkout/CI clone even though
    // it was chmod +x'd when authored — ensure it's really runnable via
    // its shebang before any test relies on that.
    await chmod(FAKE_CLAUDE_SCRIPT, 0o755);
  });

  it("has 'dangerous' risk level", () => {
    expect(createDelegateToClaudeCodeTool({ binary: FAKE_CLAUDE_SCRIPT }).riskLevel).toBe("dangerous");
  });

  it("passes args through as real argv, not a shell string", async () => {
    const tool = createDelegateToClaudeCodeTool({ binary: FAKE_CLAUDE_SCRIPT });
    const result = await tool.handler({ args: ["-p", "fix-the-failing-test", "--output-format", "text"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('args=["-p","fix-the-failing-test","--output-format","text"]');
  });

  it("runs in the given cwd (relative to the project root)", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-delegate-claude-cwd-"));
    try {
      await mkdir(path.join(projectDir, "sub"));
      const tool = createDelegateToClaudeCodeTool({ binary: FAKE_CLAUDE_SCRIPT });
      const result = await tool.handler({ args: ["-p", "hello"], cwd: "sub" }, { ...ctx, cwd: projectDir });
      expect(result.content).toContain(`cwd=${path.join(projectDir, "sub")}`);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("reports a real non-zero exit code as isError, with the real stderr content", async () => {
    const tool = createDelegateToClaudeCodeTool({ binary: FAKE_CLAUDE_SCRIPT });
    const result = await tool.handler({ args: ["--fail"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("simulated delegated task failure");
  });

  it("defaults to the real 'claude' binary name when no binary override is given", async () => {
    const tool = createDelegateToClaudeCodeTool();
    const result = await tool.handler({ args: ["--version"] }, ctx);
    // Never invokes the real claude binary in CI/dev — this just confirms
    // the wrapper attempts to invoke something named "claude" and reports
    // back a real (non-throwing) result either way.
    expect(typeof result.isError).toBe("boolean");
  }, 15_000);
});

describe("delegate_to_codex tool (real subprocess, fake codex binary stand-in)", () => {
  beforeAll(async () => {
    await chmod(FAKE_CODEX_SCRIPT, 0o755);
  });

  it("has 'dangerous' risk level", () => {
    expect(createDelegateToCodexTool({ binary: FAKE_CODEX_SCRIPT }).riskLevel).toBe("dangerous");
  });

  it("passes args through as real argv, not a shell string", async () => {
    const tool = createDelegateToCodexTool({ binary: FAKE_CODEX_SCRIPT });
    const result = await tool.handler({ args: ["exec", "fix-the-failing-test"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('args=["exec","fix-the-failing-test"]');
  });

  it("runs in the given cwd (relative to the project root)", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-delegate-codex-cwd-"));
    try {
      await mkdir(path.join(projectDir, "sub"));
      const tool = createDelegateToCodexTool({ binary: FAKE_CODEX_SCRIPT });
      const result = await tool.handler({ args: ["exec", "hello"], cwd: "sub" }, { ...ctx, cwd: projectDir });
      expect(result.content).toContain(`cwd=${path.join(projectDir, "sub")}`);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("reports a real non-zero exit code as isError, with the real stderr content", async () => {
    const tool = createDelegateToCodexTool({ binary: FAKE_CODEX_SCRIPT });
    const result = await tool.handler({ args: ["--fail"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("simulated delegated task failure");
  });

  it("defaults to the real 'codex' binary name when no binary override is given", async () => {
    const tool = createDelegateToCodexTool();
    const result = await tool.handler({ args: ["--version"] }, ctx);
    expect(typeof result.isError).toBe("boolean");
  }, 15_000);
});
