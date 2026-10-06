import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { AgentSession } from "../../src/core/session.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { HooksConfig } from "../../src/hooks/config.js";
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

function makeCtx(cwd: string, args = "", hooks: HooksConfig = {}) {
  const ui = makeUi();
  const session = new AgentSession({ cwd, model: "test-model", systemPrompt: "s" });
  const ctx = {
    session,
    ui,
    tools: new ToolRegistry(),
    permissions: { getHooksConfig: () => hooks },
    mcp: {},
    provider: {},
    cwd,
    args,
    setSession: vi.fn(),
  } as never;
  return { ctx, ui };
}

describe("extra slash commands", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  it("registers every new command", () => {
    for (const name of ["hooks", "status", "diff", "init", "review", "agents", "bug"]) expect(commands.get(name)).toBeTypeOf("function");
  });

  it("/hooks lists configured hooks per event and explains how to add them when empty", async () => {
    const hooks: HooksConfig = { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }], PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "check.sh" }] }] };
    const { ctx, ui } = makeCtx("/tmp", "", hooks);
    await commands.get("hooks")!(ctx);
    const text = vi.mocked(ui.writeSystem).mock.calls[0][0];
    expect(text).toContain("2 hook(s) configured");
    expect(text).toContain("PreToolUse (matcher: bash): check.sh");
    expect(text).toContain("Stop: echo done");

    const empty = makeCtx("/tmp");
    await commands.get("hooks")!(empty.ctx);
    expect(vi.mocked(empty.ui.writeSystem).mock.calls[0][0]).toContain("No hooks configured");
  });

  it("/status reports session state", async () => {
    const { ctx, ui } = makeCtx("/tmp");
    await commands.get("status")!(ctx);
    const text = vi.mocked(ui.writeSystem).mock.calls[0][0];
    expect(text).toContain("model: test-model");
    expect(text).toContain("plan mode: off");
  });

  it("/diff shows a summary and untracked files, and /diff full the patch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-diff-"));
    const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    run("init", "-q");
    run("config", "user.email", "t@t");
    run("config", "user.name", "t");
    await writeFile(path.join(dir, "a.txt"), "one\n");
    run("add", ".");
    run("commit", "-qm", "init");

    const clean = makeCtx(dir);
    await commands.get("diff")!(clean.ctx);
    expect(vi.mocked(clean.ui.writeSystem).mock.calls[0][0]).toBe("No uncommitted changes.");

    await writeFile(path.join(dir, "a.txt"), "two\n");
    await writeFile(path.join(dir, "b.txt"), "new\n");
    const summary = makeCtx(dir);
    await commands.get("diff")!(summary.ctx);
    const text = vi.mocked(summary.ui.writeSystem).mock.calls[0][0];
    expect(text).toContain("a.txt");
    expect(text).toContain("Untracked:\nb.txt");

    const full = makeCtx(dir, "full");
    await commands.get("diff")!(full.ctx);
    expect(vi.mocked(full.ui.writeSystem).mock.calls[0][0]).toContain("+two");
  });

  it("/diff errors cleanly outside a git repository", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-nogit-"));
    const { ctx, ui } = makeCtx(dir);
    await commands.get("diff")!(ctx);
    expect(ui.writeError).toHaveBeenCalled();
  });

  it("/bug prints the issue link and diagnostics", async () => {
    const { ctx, ui } = makeCtx("/tmp");
    await commands.get("bug")!(ctx);
    const text = vi.mocked(ui.writeSystem).mock.calls[0][0];
    expect(text).toContain("github.com/Ronaldo-F-dev/finanfa-code/issues/new");
    expect(text).toContain("model: test-model");
  });
});
