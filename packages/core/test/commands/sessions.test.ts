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
      mcp: undefined as never, provider: undefined as never,
      setSession: () => {},
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

  it("a typo'd subcommand (e.g. 'deletee') errors instead of silently listing sessions", async () => {
    const current = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "s" });
    await current.persist();

    const ctx = baseCtx(current, "deletee all");
    await commands.get("sessions")!(ctx);

    expect(ctx.ui.writeError).toHaveBeenCalledWith(expect.stringContaining('Unknown "/sessions deletee"'));
    expect(ctx.ui.writeSystem).not.toHaveBeenCalled();
  });

  it("'/sessions delete' with no id shows usage instead of silently listing sessions", async () => {
    const current = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "s" });
    await current.persist();

    const ctx = baseCtx(current, "delete");
    await commands.get("sessions")!(ctx);

    expect(ctx.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Usage: /sessions delete"));
    expect(ctx.ui.writeSystem).not.toHaveBeenCalled();
  });

  it("bare /sessions (no args) still lists normally", async () => {
    const current = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "s" });
    await current.persist();

    const ctx = baseCtx(current, "");
    await commands.get("sessions")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining(current.id));
    expect(ctx.ui.writeError).not.toHaveBeenCalled();
  });

  it("shows a session's title (not just its id) once one has been generated", async () => {
    const current = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "s" });
    current.title = "Weekly budget planning";
    await current.persist();

    const ctx = baseCtx(current, "");
    await commands.get("sessions")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining('"Weekly budget planning"'));
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining(current.id));
  });
});

describe("/session <id> command", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  let projectDir: string;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-session-cmd-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-session-cmd-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  function ctxFor(session: AgentSession, args: string) {
    const setSession = vi.fn();
    return {
      session,
      ui: makeUi(),
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never, provider: undefined as never,
      setSession,
      cwd: projectDir,
      args,
    };
  }

  it("switches to a different saved session by id, real end-to-end", async () => {
    const current = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "sys" });
    current.messages = [{ role: "user", content: "current session content" }];
    const other = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "sys" });
    other.messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    other.title = "Other session";
    await other.persist();

    const ctx = ctxFor(current, other.id);
    await commands.get("session")!(ctx);

    expect(ctx.setSession).toHaveBeenCalledTimes(1);
    const switched = ctx.setSession.mock.calls[0][0] as AgentSession;
    expect(switched.id).toBe(other.id);
    expect(switched.messages).toEqual(other.messages);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("Other session"));
  });

  it("persists the outgoing session before switching away, so nothing from it is lost", async () => {
    const current = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "sys" });
    current.messages = [{ role: "user", content: "don't lose me" }];
    const other = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "sys" });
    await other.persist();

    await commands.get("session")!(ctxFor(current, other.id));

    const reloaded = await AgentSession.resume(projectDir, current.id, "sys");
    expect(reloaded.messages).toEqual(current.messages);
  });

  it("errors clearly for an id that doesn't exist, without touching setSession", async () => {
    const current = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "sys" });
    const ctx = ctxFor(current, "not-a-real-session-id");

    await commands.get("session")!(ctx);

    expect(ctx.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("not-a-real-session-id"));
    expect(ctx.setSession).not.toHaveBeenCalled();
  });

  it("is a no-op when asked to switch to the already-current session", async () => {
    const current = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "sys" });
    const ctx = ctxFor(current, current.id);

    await commands.get("session")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith("Already on this session.");
    expect(ctx.setSession).not.toHaveBeenCalled();
  });

  it("shows usage with no id given", async () => {
    const current = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "sys" });
    const ctx = ctxFor(current, "");

    await commands.get("session")!(ctx);

    expect(ctx.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Usage: /session <id>"));
    expect(ctx.setSession).not.toHaveBeenCalled();
  });
});
