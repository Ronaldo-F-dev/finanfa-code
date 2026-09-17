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

describe("/exit command", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  function baseCtx() {
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
      customCommands: undefined,
    };
  }

  it("says bye bye before quitting", async () => {
    const ctx = baseCtx();
    const result = await commands.get("exit")!(ctx);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith("bye bye");
    expect(result).toBe("exit");
  });
});
