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

describe("/todos command", () => {
  it("shows the current checklist from the session", async () => {
    const commands = new CommandRegistry();
    registerBuiltinCommands(commands);
    const session = new AgentSession({ cwd: "/tmp", model: "m", systemPrompt: "s" });
    session.todos.set([{ content: "step 1", status: "completed" }]);
    const ui = makeUi();

    const handler = commands.get("todos")!;
    await handler({
      session,
      ui,
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never, provider: undefined as never,
      setSession: () => {},
      cwd: "/tmp",
      args: "",
    });

    expect(ui.writeSystem).toHaveBeenCalledWith("[x] step 1");
  });

  it("reports when there are no todos", async () => {
    const commands = new CommandRegistry();
    registerBuiltinCommands(commands);
    const session = new AgentSession({ cwd: "/tmp", model: "m", systemPrompt: "s" });
    const ui = makeUi();

    const handler = commands.get("todos")!;
    await handler({
      session,
      ui,
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never, provider: undefined as never,
      setSession: () => {},
      cwd: "/tmp",
      args: "",
    });

    expect(ui.writeSystem).toHaveBeenCalledWith("(no todos)");
  });
});
