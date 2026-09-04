import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { AgentSession } from "../../src/core/session.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { McpClientManager } from "../../src/mcp/client-manager.js";
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
      provider: undefined as never,
      cwd: "/tmp",
      args,
      setSession: () => {},
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

describe("/mcp add", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-mcp-add-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function addCtx(mcp: McpClientManager, args: string) {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    return { session, ui: makeUi(), tools: new ToolRegistry(), permissions: undefined as never, mcp, provider: undefined as never, cwd: dir, args, setSession: () => {} };
  }

  async function readServers(): Promise<{ name: string }[]> {
    const raw = await readFile(path.join(dir, ".finanfa-code", "mcp.json"), "utf-8");
    return (JSON.parse(raw) as { servers: { name: string }[] }).servers;
  }

  it("persists a stdio server (name -- command args) and connects it", async () => {
    const mcp = makeFakeMcp([]);
    const ctx = addCtx(mcp, "add github -- docker run -i ghcr.io/github/github-mcp-server");
    await commands.get("mcp")!(ctx);

    expect(mcp.connect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "github", transport: "stdio", command: "docker" }),
    );
    const servers = await readServers();
    expect(servers).toEqual([
      expect.objectContaining({ name: "github", command: "docker", args: ["run", "-i", "ghcr.io/github/github-mcp-server"] }),
    ]);
  });

  it("persists an http/sse server (name --url ...)", async () => {
    const mcp = makeFakeMcp([]);
    const ctx = addCtx(mcp, "add notion --url https://mcp.notion.com/sse --transport sse");
    await commands.get("mcp")!(ctx);

    const servers = await readServers();
    expect(servers).toEqual([{ name: "notion", transport: "sse", url: "https://mcp.notion.com/sse" }]);
  });

  it("adding a server with an existing name replaces it, instead of duplicating", async () => {
    const mcp = makeFakeMcp([]);
    await commands.get("mcp")!(addCtx(mcp, "add github -- old-command"));
    await commands.get("mcp")!(addCtx(mcp, "add github -- new-command"));

    const servers = await readServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ command: "new-command" });
  });

  it("adding a second, differently-named server keeps both", async () => {
    const mcp = makeFakeMcp([]);
    await commands.get("mcp")!(addCtx(mcp, "add github -- cmd-a"));
    await commands.get("mcp")!(addCtx(mcp, "add notion -- cmd-b"));

    const servers = await readServers();
    expect(servers.map((s) => s.name).sort()).toEqual(["github", "notion"]);
  });

  it("malformed args (missing -- or --url) show usage and write nothing", async () => {
    const mcp = makeFakeMcp([]);
    const ctx = addCtx(mcp, "add github not-a-valid-form");
    await commands.get("mcp")!(ctx);

    expect(ctx.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(mcp.connect).not.toHaveBeenCalled();
    await expect(readServers()).rejects.toThrow();
  });
});
