import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { AgentSession } from "../../src/core/session.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import { globalConfigPath } from "../../src/core/config.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeUi(): UIAdapter {
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
    askUser: vi.fn().mockResolvedValue(""),
    close: vi.fn(),
  };
}

const originalHome = process.env.HOME;
beforeEach(async () => {
  process.env.HOME = await mkdtemp(path.join(tmpdir(), "finanfa-perm-cmd-"));
});
afterEach(() => {
  process.env.HOME = originalHome;
});

describe("/permissions auto-approve", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  /** `setup` prepares the manager BEFORE the command runs (the command starts executing as soon as it is called). */
  function run(args: string, setup?: (permissions: PermissionManager) => void) {
    const ui = makeUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
    setup?.(permissions);
    const ctx = { session: new AgentSession({ cwd: "/tmp", model: "m", systemPrompt: "s" }), ui, tools: {}, permissions, mcp: {}, provider: {}, cwd: "/tmp", args, setSession: vi.fn() } as never;
    return { ui, permissions, done: commands.get("permissions")!(ctx) };
  }

  it("shows every category and its state with no arguments", async () => {
    const { ui, done } = run("auto-approve", (p) => p.setAutoApprove("mcp", true));
    await done;
    const text = vi.mocked(ui.writeSystem).mock.calls[0][0];
    expect(text).toMatch(/edits: off/);
    expect(text).toMatch(/terminal: off/);
    expect(text).toMatch(/mcp: ON/);
  });

  it("switches a category on for the session only", async () => {
    const { ui, permissions, done } = run("auto-approve edits on");
    await done;
    expect(permissions.getAutoApprove()).toEqual({ edits: true });
    expect(vi.mocked(ui.writeSystem).mock.calls[0][0]).toContain("for this session");
    await expect(readFile(globalConfigPath(), "utf-8")).rejects.toThrow(); // nothing saved
  });

  it("saves to the global config with the save keyword, keeping the other categories", async () => {
    const first = run("auto-approve mcp on save");
    await first.done;
    const second = run("auto-approve edits on save");
    await second.done;
    // each run builds a fresh manager from DEFAULT config, so the second save holds only what it set itself
    expect(JSON.parse(await readFile(globalConfigPath(), "utf-8"))).toEqual({ autoApprove: { edits: true } });
    expect(vi.mocked(second.ui.writeSystem).mock.calls[0][0]).toContain("saved to your global config");
  });

  it("warns when the terminal is switched on", async () => {
    const { ui, done } = run("auto-approve terminal on");
    await done;
    expect(vi.mocked(ui.writeSystem).mock.calls[0][0]).toContain("Shell commands now run without a prompt");
  });

  it("switches off again", async () => {
    const { permissions, done } = run("auto-approve edits off", (p) => p.setAutoApprove("edits", true));
    await done;
    expect(permissions.getAutoApprove()).toEqual({ edits: false });
  });

  it.each(["auto-approve nonsense on", "auto-approve edits maybe", "auto-approve edits on later", "auto-approve edits"])("rejects %j with the usage", async (args) => {
    const { ui, permissions, done } = run(args);
    await done;
    expect(ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Usage: /permissions auto-approve"));
    expect(permissions.getAutoApprove()).toEqual({});
  });

  it("still handles the classifier subcommand as before", async () => {
    const { ui, done } = run("auto-classifier");
    await done;
    expect(vi.mocked(ui.writeSystem).mock.calls[0][0]).toContain("Auto-approval classifier is OFF");
  });
});
