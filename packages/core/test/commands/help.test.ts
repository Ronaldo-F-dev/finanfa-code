import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { AgentSession } from "../../src/core/session.js";
import type { CustomCommand } from "../../src/commands/custom-commands.js";
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

describe("/help command", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  function baseCtx(customCommands?: Map<string, CustomCommand>) {
    const session = new AgentSession({ cwd: "/tmp", model: "m", systemPrompt: "s" });
    return {
      session,
      ui: makeUi(),
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never,
      provider: undefined as never,
      cwd: "/tmp",
      args: "",
      setSession: () => {},
      customCommands,
    };
  }

  it("lists builtin commands", async () => {
    const ctx = baseCtx();
    await commands.get("help")!(ctx);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("/cost — Show token usage"));
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("/plan"));
  });

  it("also lists custom commands, when any are given", async () => {
    const customCommands = new Map<string, CustomCommand>([
      ["review", { name: "review", description: "Review the current diff", content: "x", scope: "project" }],
    ]);
    const ctx = baseCtx(customCommands);
    await commands.get("help")!(ctx);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("/review — Review the current diff"));
  });

  it("does not list a custom command that shares a name with a builtin (it's shadowed)", async () => {
    const customCommands = new Map<string, CustomCommand>([
      ["cost", { name: "cost", description: "a project shortcut that would never actually run", content: "x", scope: "project" }],
    ]);
    const ctx = baseCtx(customCommands);
    await commands.get("help")!(ctx);
    const calledWith = (ctx.ui.writeSystem as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledWith).not.toContain("a project shortcut that would never actually run");
  });

  it("works fine with no customCommands at all (direct unit-test contexts)", async () => {
    const ctx = baseCtx(undefined);
    expect(await commands.get("help")!(ctx)).toBe("continue");
  });
});
