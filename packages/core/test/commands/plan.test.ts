import { describe, expect, it, vi } from "vitest";
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

describe("/plan command", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  function baseCtx(args: string) {
    const session = new AgentSession({ cwd: "/tmp", model: "m", systemPrompt: "s" });
    return {
      session,
      ui: makeUi(),
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never,
      provider: undefined as never,
      cwd: "/tmp",
      args,
      setSession: () => {},
    };
  }

  it("/plan on turns plan mode on", async () => {
    const ctx = baseCtx("on");
    await commands.get("plan")!(ctx);
    expect(ctx.session.planMode).toBe(true);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("Plan mode ON"));
  });

  it("/plan off turns plan mode off", async () => {
    const ctx = baseCtx("off");
    ctx.session.planMode = true;
    await commands.get("plan")!(ctx);
    expect(ctx.session.planMode).toBe(false);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("Plan mode OFF"));
  });

  it("/plan with no args reports the current state without changing it", async () => {
    const ctx = baseCtx("");
    ctx.session.planMode = true;
    await commands.get("plan")!(ctx);
    expect(ctx.session.planMode).toBe(true);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("ON"));
  });

  it("rejects an unrecognized argument", async () => {
    const ctx = baseCtx("maybe");
    await commands.get("plan")!(ctx);
    expect(ctx.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Usage: /plan"));
  });
});
