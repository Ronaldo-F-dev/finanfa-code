import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { AgentSession } from "../../src/core/session.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolDefinition } from "../../src/core/types.js";
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

const fakeTool = (name: string, riskLevel: ToolDefinition["riskLevel"] = "safe"): ToolDefinition => ({
  name,
  description: "",
  riskLevel,
  inputSchema: { type: "object" },
  handler: async () => ({ content: "", isError: false }),
});

describe("/tools command", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  function baseCtx(tools: ToolRegistry, args: string) {
    const session = new AgentSession({ cwd: "/tmp", model: "m", systemPrompt: "s" });
    return {
      session,
      ui: makeUi(),
      tools,
      permissions: undefined as never,
      mcp: undefined as never,
      provider: undefined as never,
      cwd: "/tmp",
      args,
      setSession: () => {},
    };
  }

  it("/tools (no args) lists every registered tool with its risk level", async () => {
    const tools = new ToolRegistry();
    tools.register(fakeTool("bash", "dangerous"));
    tools.register(fakeTool("read_file", "safe"));

    const ctx = baseCtx(tools, "");
    await commands.get("tools")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("bash [dangerous]"));
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("read_file [safe]"));
  });

  it("/tools list is equivalent to /tools with no args", async () => {
    const tools = new ToolRegistry();
    tools.register(fakeTool("bash", "dangerous"));

    const ctx = baseCtx(tools, "list");
    await commands.get("tools")!(ctx);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("bash [dangerous]"));
  });

  it("reports no tools registered when the registry is empty", async () => {
    const ctx = baseCtx(new ToolRegistry(), "");
    await commands.get("tools")!(ctx);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith("No tools registered.");
  });

  it("/tools disable <name> marks a tool disabled in the listing", async () => {
    const tools = new ToolRegistry();
    tools.register(fakeTool("bash", "dangerous"));

    const ctx = baseCtx(tools, "disable bash");
    await commands.get("tools")!(ctx);
    expect(ctx.session.disabledTools.has("bash")).toBe(true);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("won't be offered"));

    const listCtx = baseCtx(tools, "");
    listCtx.session.disabledTools.add("bash");
    await commands.get("tools")!(listCtx);
    expect(listCtx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("bash [dangerous] (disabled)"));
  });

  it("/tools enable <name> clears the disabled marker", async () => {
    const tools = new ToolRegistry();
    tools.register(fakeTool("bash", "dangerous"));

    const ctx = baseCtx(tools, "enable bash");
    ctx.session.disabledTools.add("bash");
    await commands.get("tools")!(ctx);
    expect(ctx.session.disabledTools.has("bash")).toBe(false);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("offered to the model again"));
  });

  it("rejects disabling/enabling an unknown tool name", async () => {
    const tools = new ToolRegistry();
    const ctx = baseCtx(tools, "disable not_a_real_tool");
    await commands.get("tools")!(ctx);
    expect(ctx.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("No registered tool named"));
  });

  it("shows usage for an unrecognized subcommand", async () => {
    const ctx = baseCtx(new ToolRegistry(), "frobnicate");
    await commands.get("tools")!(ctx);
    expect(ctx.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Usage: /tools"));
  });
});
