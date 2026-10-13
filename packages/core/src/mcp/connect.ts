import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolRegistry } from "../tools/registry.js";
import type { UIAdapter } from "../ui/adapter.js";
import { loadMcpServers } from "./config.js";
import { MCP_CATALOG } from "./catalog.js";
import { MCP_TOOL_PREFIX, type McpClientManager } from "./client-manager.js";

/** Re-registers the `mcp__*` tools from every connected server — shared by web-server's "mcp_reload" handler and the VS Code runner's own, which used to duplicate this pair of lines. */
export async function reloadMcpTools(tools: ToolRegistry, mcp: McpClientManager): Promise<void> {
  tools.unregisterByPrefix(MCP_TOOL_PREFIX);
  for (const def of await mcp.listAllTools()) tools.register(def);
}

/**
 * Connects one server by name, adding it to the project's own
 * .finanfa-code/mcp.json first when it's a known catalog entry — the exact
 * body web-server's "mcp_connect" handler and the VS Code runner's
 * mcpConnect both needed, extracted here rather than kept in two copies.
 * Returns true only for a genuinely fresh successful connect; that is the
 * one case web-server's caller clears its needsAuth marker for.
 *
 * OAuth prompts stay enabled (mcp.connect's own default): connecting to a
 * remote server may open a browser tab on the machine running this process,
 * which is exactly what the panel's hint text tells the user to expect.
 */
export async function connectMcpServer(cwd: string, mcp: McpClientManager, tools: ToolRegistry, name: string, ui: UIAdapter): Promise<boolean> {
  const existing = await loadMcpServers(cwd);
  let config = existing.find((s) => s.name === name);
  if (!config) {
    const fromCatalog = MCP_CATALOG.find((c) => c.name === name);
    if (fromCatalog) {
      const file = path.join(cwd, ".finanfa-code", "mcp.json");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ servers: [...existing, fromCatalog] }, null, 2), "utf-8");
      config = fromCatalog;
    }
  }
  if (!config) {
    ui.writeError(`No MCP server named "${name}" in .finanfa-code/mcp.json.`);
    return false;
  }
  if (mcp.connectedServers().includes(name)) {
    ui.writeSystem(`"${name}" is already connected.`);
    return false;
  }
  if (config.transport !== "stdio") ui.writeSystem(`Connecting to "${name}", if it requires authorization, a browser tab will open on the server...`);
  try {
    await mcp.connect(config);
    await reloadMcpTools(tools, mcp);
    ui.writeSystem(`Connected "${name}".`);
    return true;
  } catch (err) {
    ui.writeError(`Failed to connect "${name}": ${err instanceof Error ? err.message : err}`);
    return false;
  }
}
