import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { AgentSession } from "../../src/core/session.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeUi(): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
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

describe("/sessions command", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  let projectDir: string;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-sessions-cmd-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-sessions-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  function baseCtx(session: AgentSession, args: string) {
    return {
      session,
      ui: makeUi(),
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never,
      cwd: projectDir,
      args,
    };
  }

  it("refuses to delete the current session — it would just get recreated", async () => {
    const session = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "s" });
    await session.persist();

    const ctx = baseCtx(session, `delete ${session.id}`);
    await commands.get("sessions")!(ctx);

    expect(ctx.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Can't delete the current session"));
    expect(await AgentSession.list(projectDir)).toHaveLength(1);
  });

  it("deletes a specific, non-current session by id", async () => {
    const current = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "s" });
    await current.persist();
    const other = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "s" });
    await other.persist();

    const ctx = baseCtx(current, `delete ${other.id}`);
    await commands.get("sessions")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(`Deleted session ${other.id}.`);
    const remaining = await AgentSession.list(projectDir);
    expect(remaining.map((s) => s.id)).toEqual([current.id]);
  });

  it("/sessions delete all removes every session except the current one", async () => {
    const current = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "s" });
    await current.persist();
    const other1 = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "s" });
    await other1.persist();
    const other2 = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "s" });
    await other2.persist();

    const ctx = baseCtx(current, "delete all");
    await commands.get("sessions")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("Deleted 2 session(s)"));
    const remaining = await AgentSession.list(projectDir);
    expect(remaining.map((s) => s.id)).toEqual([current.id]);
  });

  it("/sessions delete all reports nothing to delete when only the current session exists", async () => {
    const current = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "s" });
    await current.persist();

    const ctx = baseCtx(current, "delete all");
    await commands.get("sessions")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith("No other saved sessions to delete.");
  });
});
