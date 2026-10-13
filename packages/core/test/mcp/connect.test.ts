import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectMcpServer, reloadMcpTools } from "../../src/mcp/connect.js";
import { MCP_CATALOG } from "../../src/mcp/catalog.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { McpClientManager } from "../../src/mcp/client-manager.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeUi() {
  const system: string[] = [];
  const errors: string[] = [];
  return {
    ui: {
      writeSystem: (text: string) => system.push(text),
      writeError: (text: string) => errors.push(text),
    } as unknown as UIAdapter,
    system,
    errors,
  };
}

function makeManager(overrides: { connected?: string[]; fail?: boolean; tools?: unknown[] } = {}) {
  const attempted: string[] = [];
  const manager = {
    connectedServers: () => overrides.connected ?? [],
    connect: async (cfg: { name: string }) => {
      attempted.push(cfg.name);
      if (overrides.fail) throw new Error("boom");
    },
    listAllTools: async () => overrides.tools ?? [],
  } as unknown as McpClientManager;
  return { manager, attempted };
}

describe("connectMcpServer (shared by web-server's mcp_connect and the VS Code runner's mcpConnect)", () => {
  it("reports an unknown name as an error and attempts no connection", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-mcp-connect-"));
    try {
      const { ui, errors } = makeUi();
      const { manager, attempted } = makeManager();

      const ok = await connectMcpServer(dir, manager, new ToolRegistry(), "not-a-server", ui);

      expect(ok).toBe(false);
      expect(attempted).toEqual([]);
      expect(errors).toEqual([expect.stringContaining("not-a-server")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adds a catalog entry to the project's mcp.json, connects it, and reports success", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-mcp-connect-"));
    try {
      const { ui } = makeUi();
      const { manager, attempted } = makeManager();
      const entry = MCP_CATALOG[0]!;

      const ok = await connectMcpServer(dir, manager, new ToolRegistry(), entry.name, ui);

      expect(ok).toBe(true);
      expect(attempted).toEqual([entry.name]);
      const written = JSON.parse(await readFile(path.join(dir, ".finanfa-code", "mcp.json"), "utf-8")) as { servers: { name: string }[] };
      expect(written.servers.map((s) => s.name)).toEqual([entry.name]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a failed connect as an error, not a crash, and does not claim success", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-mcp-connect-"));
    try {
      const { ui, errors } = makeUi();
      const { manager } = makeManager({ fail: true });
      const entry = MCP_CATALOG[0]!;

      const ok = await connectMcpServer(dir, manager, new ToolRegistry(), entry.name, ui);

      expect(ok).toBe(false);
      expect(errors).toEqual([expect.stringContaining("boom")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says a connected server is already connected instead of reconnecting it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-mcp-connect-"));
    try {
      const { ui, system } = makeUi();
      const entry = MCP_CATALOG[0]!;
      const { manager, attempted } = makeManager({ connected: [entry.name] });

      const ok = await connectMcpServer(dir, manager, new ToolRegistry(), entry.name, ui);

      expect(ok).toBe(false);
      expect(attempted).toEqual([]);
      expect(system).toEqual([expect.stringContaining("already connected")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("reloadMcpTools", () => {
  it("drops every old mcp__* tool and registers the fresh list", async () => {
    const tools = new ToolRegistry();
    const toolDef = (name: string) => ({
      name,
      description: "d",
      inputSchema: { type: "object" },
      riskLevel: "safe" as const,
      handler: async () => ({ content: "", isError: false }),
    });
    tools.register(toolDef("mcp__old__gone"));
    const { manager } = makeManager({ tools: [toolDef("mcp__new__here")] });

    await reloadMcpTools(tools, manager);

    expect(tools.list().map((t) => t.name)).toEqual(["mcp__new__here"]);
  });
});
