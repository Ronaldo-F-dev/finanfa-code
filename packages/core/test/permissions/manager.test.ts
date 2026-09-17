import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { HooksConfig } from "../../src/hooks/config.js";
import type { ToolDefinition, ToolContext } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";
import { auditFilePath } from "../../src/observability/audit-log.js";

function makeUi(answer: string): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
    writeBanner: vi.fn(),
    writeSystem: vi.fn(),
    writeError: vi.fn(),
    setStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(undefined),
    setCommands: vi.fn(),
    setBusy: vi.fn(),
    askUser: vi.fn().mockResolvedValue(answer),
    close: vi.fn(),
  };
}

const ctx: ToolContext = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

const safeTool: ToolDefinition = {
  name: "safe_tool",
  description: "",
  riskLevel: "safe",
  inputSchema: { type: "object" },
  handler: async () => ({ content: "", isError: false }),
};

const bashLikeTool: ToolDefinition<{ command: string }> = {
  name: "bash",
  description: "",
  riskLevel: "dangerous",
  inputSchema: { type: "object" },
  riskKey: (input) => input.command.split(" ")[0],
  handler: async () => ({ content: "", isError: false }),
};

describe("PermissionManager", () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // check() now writes an audit-log entry for every decision (see
    // audit-log.ts) — isolate HOME so these tests don't append real
    // entries to the developer's own ~/.finanfa-code/audit/.
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-permissions-audit-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  async function readAuditEvents(): Promise<Record<string, unknown>[]> {
    const raw = await readFile(auditFilePath(), "utf-8");
    return raw.trim().split("\n").map((l) => JSON.parse(l));
  }

  it("allows safe tools without prompting", async () => {
    const ui = makeUi("y");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
    const decision = await manager.check(safeTool, {}, ctx);
    expect(decision).toBe("allow");
    expect(ui.askUser).not.toHaveBeenCalled();
  });

  it("prompts for dangerous tools and respects 'no'", async () => {
    const ui = makeUi("n");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
    const decision = await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);
    expect(decision).toBe("deny");
  });

  it("passes the caller's toolCallId through to askUser, for an adapter that needs to correlate the ask with the real tool_call", async () => {
    const ui = makeUi("y");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });

    await manager.check(bashLikeTool, { command: "git status" }, ctx, "call-42");
    expect(ui.askUser).toHaveBeenCalledWith(expect.any(String), "confirm", "call-42");
  });

  it("remembers 'always' for the same risk key only", async () => {
    const ui = makeUi("a");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });

    const first = await manager.check(bashLikeTool, { command: "git status" }, ctx);
    expect(first).toBe("allow");
    expect(ui.askUser).toHaveBeenCalledTimes(1);

    // same prefix again → no new prompt
    const second = await manager.check(bashLikeTool, { command: "git status" }, ctx);
    expect(second).toBe("allow");
    expect(ui.askUser).toHaveBeenCalledTimes(1);

    // different prefix → prompts again
    await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);
    expect(ui.askUser).toHaveBeenCalledTimes(2);
  });

  it("'t' (always allow this tool) covers every risk key of that tool, but not other tools", async () => {
    const ui = makeUi("t");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });

    const first = await manager.check(bashLikeTool, { command: "git status" }, ctx);
    expect(first).toBe("allow");
    expect(ui.askUser).toHaveBeenCalledTimes(1);

    // Same tool, a totally different risk key (would have re-prompted under "a") → no new prompt.
    const second = await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);
    expect(second).toBe("allow");
    expect(ui.askUser).toHaveBeenCalledTimes(1);

    // A different tool entirely is not covered — the real confusion this was
    // built to prevent: choosing "always allow" for bash must not silently
    // also cover write_file/edit_file/etc.
    const otherTool: ToolDefinition = { ...safeTool, name: "write_file", riskLevel: "dangerous" };
    await manager.check(otherTool, {}, ctx);
    expect(ui.askUser).toHaveBeenCalledTimes(2);
  });

  it("names the specific tool in the prompt, so \"always allow\" scope isn't ambiguous", async () => {
    const ui = makeUi("y");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });

    await manager.check(bashLikeTool, { command: "git status" }, ctx);

    const promptText = (ui.askUser as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptText).toContain('always allow "bash" this session');
  });

  it("--yolo bypasses all prompts", async () => {
    const ui = makeUi("n");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const decision = await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);
    expect(decision).toBe("allow");
    expect(ui.askUser).not.toHaveBeenCalled();
  });

  it("--non-interactive auto-denies without prompting", async () => {
    const ui = makeUi("y");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, nonInteractive: true });
    const decision = await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);
    expect(decision).toBe("deny");
    expect(ui.askUser).not.toHaveBeenCalled();
  });

  it("re-prompts on unrecognized input instead of failing open to allow", async () => {
    const ui: UIAdapter = {
      writeAssistantDelta: vi.fn(),
      endAssistantMessage: vi.fn(),
    writeBanner: vi.fn(),
      writeSystem: vi.fn(),
      writeError: vi.fn(),
      setStatus: vi.fn(),
      getStatus: vi.fn().mockReturnValue(undefined),
      setCommands: vi.fn(),
      setBusy: vi.fn(),
      askUser: vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("asdf").mockResolvedValueOnce("n"),
      close: vi.fn(),
    };
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
    const decision = await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);
    expect(decision).toBe("deny");
    expect(ui.askUser).toHaveBeenCalledTimes(3);
    expect(ui.writeError).toHaveBeenCalledTimes(2);
  });

  it("a PreToolUse hook that blocks denies without ever prompting, even under --yolo", async () => {
    const ui = makeUi("y");
    const hooksConfig: HooksConfig = {
      PreToolUse: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo '{\"decision\":\"block\",\"reason\":\"org policy\"}'" }] }],
    };
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig });
    const decision = await manager.check(safeTool, {}, ctx);
    expect(decision).toBe("deny");
    expect(ui.askUser).not.toHaveBeenCalled();
    expect(ui.writeError).toHaveBeenCalledWith(expect.stringContaining("org policy"));
  });

  it("a PreToolUse hook that approves allows without ever prompting", async () => {
    const ui = makeUi("n"); // would deny if actually asked — proves the prompt was skipped, not coincidentally allowed
    const hooksConfig: HooksConfig = {
      PreToolUse: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo '{\"decision\":\"approve\"}'" }] }],
    };
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, hooksConfig });
    const decision = await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);
    expect(decision).toBe("allow");
    expect(ui.askUser).not.toHaveBeenCalled();
  });

  it("a PreToolUse hook with no opinion falls through to the normal permission flow", async () => {
    const ui = makeUi("y");
    const hooksConfig: HooksConfig = { PreToolUse: [{ hooks: [{ type: "command", command: "cat > /dev/null; exit 0" }] }] };
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, hooksConfig });
    const decision = await manager.check(bashLikeTool, { command: "git status" }, ctx);
    expect(decision).toBe("allow");
    expect(ui.askUser).toHaveBeenCalledTimes(1);
  });

  it("only runs a hook whose matcher matches the tool actually being checked", async () => {
    const ui = makeUi("y");
    const hooksConfig: HooksConfig = {
      PreToolUse: [{ matcher: "^write_file$", hooks: [{ type: "command", command: "cat > /dev/null; echo '{\"decision\":\"block\"}'" }] }],
    };
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, hooksConfig });
    const decision = await manager.check(bashLikeTool, { command: "git status" }, ctx); // tool name "bash", doesn't match "^write_file$"
    expect(decision).toBe("allow");
  });

  it("runPostToolUseHook surfaces a hook's plain stdout to the user", async () => {
    const ui = makeUi("y");
    const hooksConfig: HooksConfig = { PostToolUse: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo formatted 3 files" }] }] };
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, hooksConfig });
    await manager.runPostToolUseHook(safeTool, {}, { isError: false, content: "ok" }, ctx);
    expect(ui.writeSystem).toHaveBeenCalledWith("formatted 3 files");
  });

  it("runPostToolUseHook surfaces a block's reason, never throwing (the tool already ran)", async () => {
    const ui = makeUi("y");
    const hooksConfig: HooksConfig = {
      PostToolUse: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo '{\"decision\":\"block\",\"reason\":\"flagged for review\"}'" }] }],
    };
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, hooksConfig });
    await expect(manager.runPostToolUseHook(safeTool, {}, { isError: false, content: "ok" }, ctx)).resolves.toBeUndefined();
    expect(ui.writeSystem).toHaveBeenCalledWith("flagged for review");
  });

  it("runPostToolUseHook does nothing when no PostToolUse hooks are configured", async () => {
    const ui = makeUi("y");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
    await manager.runPostToolUseHook(safeTool, {}, { isError: false, content: "ok" }, ctx);
    expect(ui.writeSystem).not.toHaveBeenCalled();
  });

  it("runUserPromptSubmitHook appends a hook's stdout as extra context on the prompt", async () => {
    const ui = makeUi("y");
    const hooksConfig: HooksConfig = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo 'on branch main, 2 files changed'" }] }] };
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, hooksConfig });
    const result = await manager.runUserPromptSubmitHook("what's the status?", "/tmp", "s");
    expect(result.blockedReason).toBeUndefined();
    expect(result.prompt).toContain("what's the status?");
    expect(result.prompt).toContain("on branch main, 2 files changed");
  });

  it("runUserPromptSubmitHook returns a blockedReason instead of the prompt when a hook blocks", async () => {
    const ui = makeUi("y");
    const hooksConfig: HooksConfig = {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo '{\"decision\":\"block\",\"reason\":\"prompts are disabled right now\"}'" }] }],
    };
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, hooksConfig });
    const result = await manager.runUserPromptSubmitHook("do something", "/tmp", "s");
    expect(result.blockedReason).toBe("prompts are disabled right now");
  });

  it("runUserPromptSubmitHook returns the prompt unchanged when no hooks are configured", async () => {
    const ui = makeUi("y");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
    const result = await manager.runUserPromptSubmitHook("hello", "/tmp", "s");
    expect(result).toEqual({ prompt: "hello" });
  });

  it("a throwing preview()/describeCall() denies instead of crashing the turn", async () => {
    const ui = makeUi("y");
    const throwingTool: ToolDefinition = {
      ...safeTool,
      name: "edit_file",
      riskLevel: "dangerous",
      describeCall: () => {
        throw new Error("old_string not found in file.txt");
      },
    };
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
    const decision = await manager.check(throwingTool, {}, ctx);
    expect(decision).toBe("deny");
    expect(ui.askUser).not.toHaveBeenCalled();
    expect(ui.writeError).toHaveBeenCalledWith(expect.stringContaining("old_string not found in file.txt"));
  });

  it(
    "a throwing riskKey() denies instead of crashing — real reported crash: bash's riskKey ran " +
      "`command.trim()` on malformed tool-call arguments falling back to input = {}",
    async () => {
      // riskKey() runs on every check() call, even below the "ask" prompt
      // path (session-allowlist / rule matching both need it first) — so
      // unlike describeCall()/preview() this must be safe even when the
      // tool ends up auto-allowed or auto-denied without ever reaching a
      // prompt.
      const ui = makeUi("y");
      const throwingRiskKeyTool: ToolDefinition = {
        ...safeTool,
        name: "bash",
        riskLevel: "dangerous",
        riskKey: () => {
          throw new TypeError("Cannot read properties of undefined (reading 'trim')");
        },
      };
      const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
      const decision = await manager.check(throwingRiskKeyTool, {}, ctx);
      expect(decision).toBe("allow");
      expect(ui.writeError).toHaveBeenCalledWith(
        expect.stringContaining("Cannot read properties of undefined (reading 'trim')"),
      );
    },
  );

  describe("audit trail", () => {
    it("records an allow decision from the default risk-level policy, with no user prompt", async () => {
      const ui = makeUi("y");
      const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
      await manager.check(safeTool, {}, ctx);

      const events = await readAuditEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ tool: "safe_tool", riskLevel: "safe", decision: "allow", source: "default_for_risk_level", sessionId: "s" });
    });

    it("records a deny decision answered directly by the user, distinct from an auto-denied one", async () => {
      const ui = makeUi("n");
      const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
      await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);

      const events = await readAuditEvents();
      expect(events[0]).toMatchObject({ tool: "bash", riskKey: "rm", decision: "deny", source: "user_prompt" });
    });

    it("records a deny decision auto-denied by --non-interactive, without ever prompting", async () => {
      const ui = makeUi("y");
      const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, nonInteractive: true });
      await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);

      const events = await readAuditEvents();
      expect(events[0]).toMatchObject({ decision: "deny", source: "non_interactive" });
    });

    it("records an allow decision bypassed by --yolo", async () => {
      const ui = makeUi("n");
      const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
      await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);

      const events = await readAuditEvents();
      expect(events[0]).toMatchObject({ decision: "allow", source: "yolo" });
    });

    it("records a decision made by a PreToolUse hook", async () => {
      const ui = makeUi("y");
      const hooksConfig: HooksConfig = {
        PreToolUse: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo '{\"decision\":\"block\",\"reason\":\"org policy\"}'" }] }],
      };
      const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, hooksConfig });
      await manager.check(safeTool, {}, ctx);

      const events = await readAuditEvents();
      expect(events[0]).toMatchObject({ decision: "deny", source: "pre_tool_use_hook" });
    });

    it("records only one entry for a repeated 'always'-allowlisted call, sourced as session_allowlist", async () => {
      const ui = makeUi("a");
      const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
      await manager.check(bashLikeTool, { command: "git status" }, ctx);
      await manager.check(bashLikeTool, { command: "git status" }, ctx);

      const events = await readAuditEvents();
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ decision: "allow", source: "user_prompt" });
      expect(events[1]).toMatchObject({ decision: "allow", source: "session_allowlist" });
    });
  });
});
