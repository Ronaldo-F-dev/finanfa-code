import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDefinition } from "../core/types.js";
import type { McpServerConfig } from "./config.js";

export const MCP_TOOL_PREFIX = "mcp__";

function toolPrefix(serverName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__`;
}

export class McpClientManager {
  private readonly clients = new Map<string, Client>();

  async connect(cfg: McpServerConfig): Promise<void> {
    const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args });
    const client = new Client({ name: "finanfa-code", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    this.clients.set(cfg.name, client);
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.clients.clear();
  }

  connectedServers(): string[] {
    return [...this.clients.keys()];
  }

  /** Lists tools from every connected server, wrapped as ToolDefinitions namespaced by server name. */
  async listAllTools(): Promise<ToolDefinition[]> {
    const definitions: ToolDefinition[] = [];

    for (const [serverName, client] of this.clients) {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        definitions.push(this.wrapTool(serverName, client, tool));
      }
    }

    return definitions;
  }

  private wrapTool(
    serverName: string,
    client: Client,
    tool: { name: string; description?: string; inputSchema: Record<string, unknown> },
  ): ToolDefinition {
    const name = `${toolPrefix(serverName)}${tool.name}`;

    return {
      name,
      description: tool.description ?? `Tool "${tool.name}" from MCP server "${serverName}"`,
      inputSchema: tool.inputSchema as ToolDefinition["inputSchema"],
      riskLevel: "ask", // external/unknown code: never trust an MCP tool by default
      describeCall: (input) => `${serverName}.${tool.name} ${JSON.stringify(input)}`,
      async handler(input) {
        const result = await client.callTool({ name: tool.name, arguments: input as Record<string, unknown> });
        const content = Array.isArray(result.content)
          ? result.content
              .map((block) => (block.type === "text" ? block.text : `[${block.type} content]`))
              .join("\n")
          : String(result.content ?? "");
        return { content, isError: Boolean(result.isError) };
      },
    };
  }
}
