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

describe("/goal command", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  let projectDir: string;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-goal-cmd-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-goal-cmd-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  function ctxFor(session: AgentSession, args: string) {
    return {
      session,
      ui: makeUi(),
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never, provider: undefined as never,
      setSession: vi.fn(),
      cwd: projectDir,
      args,
    };
  }

  it("reports no goal set, with usage, when bare and nothing was ever set", async () => {
    const session = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "sys" });
    const ctx = ctxFor(session, "");

    await commands.get("goal")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("No goal set"));
  });

  it("sets a goal, persists it, and shows it back on a bare /goal", async () => {
    const session = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "sys" });

    await commands.get("goal")!(ctxFor(session, "migrate the auth system to OAuth"));
    expect(session.goal).toBe("migrate the auth system to OAuth");

    const reloaded = await AgentSession.resume(projectDir, session.id, "sys");
    expect(reloaded.goal).toBe("migrate the auth system to OAuth");

    const ctx2 = ctxFor(session, "");
    await commands.get("goal")!(ctx2);
    expect(ctx2.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("migrate the auth system to OAuth"));
  });

  it("clears a set goal and persists the clear", async () => {
    const session = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "sys" });
    session.goal = "some goal";
    await session.persist();

    const ctx = ctxFor(session, "clear");
    await commands.get("goal")!(ctx);

    expect(session.goal).toBeUndefined();
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith("Goal cleared.");

    const reloaded = await AgentSession.resume(projectDir, session.id, "sys");
    expect(reloaded.goal).toBeUndefined();
  });

  it("treats a goal that happens to start with the word 'clear' as real goal text, not the clear subcommand", async () => {
    const session = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "sys" });

    await commands.get("goal")!(ctxFor(session, "clear the technical debt in auth.ts"));

    expect(session.goal).toBe("clear the technical debt in auth.ts");
  });

  it("reports nothing to clear when /goal clear is used with no goal set", async () => {
    const session = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "sys" });
    const ctx = ctxFor(session, "clear");

    await commands.get("goal")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith("No goal was set.");
  });
});
