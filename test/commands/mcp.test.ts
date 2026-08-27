import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { AgentSession } from "../../src/core/session.js";
import type { McpClientManager } from "../../src/mcp/client-manager.js";
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

function makeFakeMcp(connected: string[]): McpClientManager {
  return {
    connectedServers: vi.fn().mockReturnValue(connected),
    listAllTools: vi.fn().mockResolvedValue([]),
    connect: vi.fn(),
    disconnectAll: vi.fn(),
  } as unknown as McpClientManager;
}

describe("/mcp command: enable/disable", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  function baseCtx(mcp: McpClientManager, args: string) {
    const session = new AgentSession({ cwd: "/tmp", model: "m", systemPrompt: "s" });
    return {
      session,
      ui: makeUi(),
      tools: undefined as never,
      permissions: undefined as never,
      mcp,
      cwd: "/tmp",
      args,
    };
  }

  it("/mcp list reports no servers when none are connected", async () => {
    const ctx = baseCtx(makeFakeMcp([]), "list");
    await commands.get("mcp")!(ctx);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith("No MCP servers connected.");
  });

  it("/mcp list shows connected servers, marking disabled ones", async () => {
    const mcp = makeFakeMcp(["github", "notion"]);
    const ctx = baseCtx(mcp, "list");
    ctx.session.disabledMcpServers.add("notion");

    await commands.get("mcp")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith("github, notion (disabled)");
  });

  it("/mcp disable <name> adds a connected server to disabledMcpServers", async () => {
    const mcp = makeFakeMcp(["github"]);
    const ctx = baseCtx(mcp, "disable github");

    await commands.get("mcp")!(ctx);

    expect(ctx.session.disabledMcpServers.has("github")).toBe(true);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("won't be offered to the model"));
  });

  it("/mcp enable <name> removes it from disabledMcpServers", async () => {
    const mcp = makeFakeMcp(["github"]);
    const ctx = baseCtx(mcp, "enable github");
    ctx.session.disabledMcpServers.add("github");

    await commands.get("mcp")!(ctx);

    expect(ctx.session.disabledMcpServers.has("github")).toBe(false);
  });

  it("/mcp disable rejects a server that isn't connected", async () => {
    const mcp = makeFakeMcp(["github"]);
    const ctx = baseCtx(mcp, "disable notion");

    await commands.get("mcp")!(ctx);

    expect(ctx.session.disabledMcpServers.has("notion")).toBe(false);
    expect(ctx.ui.writeError).toHaveBeenCalledWith(expect.stringContaining('No connected MCP server named "notion"'));
  });

  it("/mcp disable with no name shows usage", async () => {
    const ctx = baseCtx(makeFakeMcp(["github"]), "disable");
    await commands.get("mcp")!(ctx);
    expect(ctx.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });
});
