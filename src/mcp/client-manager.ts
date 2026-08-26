import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ToolDefinition } from "../core/types.js";
import type { McpServerConfig } from "./config.js";
import { FileOAuthClientProvider } from "./oauth-provider.js";

export const MCP_TOOL_PREFIX = "mcp__";

type RemoteTransport = StreamableHTTPClientTransport | SSEClientTransport;

function toolPrefix(serverName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__`;
}

interface BuiltTransport {
  transport: StdioClientTransport | RemoteTransport;
  authProvider?: FileOAuthClientProvider;
}

function buildTransport(cfg: McpServerConfig): BuiltTransport {
  if (cfg.transport === "stdio") {
    if (!cfg.command) throw new Error(`MCP server "${cfg.name}": stdio transport requires "command"`);
    return { transport: new StdioClientTransport({ command: cfg.command, args: cfg.args }) };
  }
  if (!cfg.url) throw new Error(`MCP server "${cfg.name}": ${cfg.transport} transport requires "url"`);
  const authProvider = new FileOAuthClientProvider(cfg.name);
  const transport =
    cfg.transport === "http"
      ? new StreamableHTTPClientTransport(new URL(cfg.url), { authProvider })
      : new SSEClientTransport(new URL(cfg.url), { authProvider });
  return { transport, authProvider };
}

export class McpClientManager {
  private readonly clients = new Map<string, Client>();

  async connect(cfg: McpServerConfig): Promise<void> {
    const { transport, authProvider } = buildTransport(cfg);
    const client = new Client({ name: "finanfa-code", version: "0.1.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
    } catch (err) {
      if (!(err instanceof UnauthorizedError) || !authProvider) throw err;

      // The transport's OAuthClientProvider already opened the browser (see
      // FileOAuthClientProvider.redirectToAuthorization) — wait for the
      // redirect, exchange the code, and retry the connection once.
      const code = await authProvider.waitForCallback();
      await (transport as RemoteTransport).finishAuth(code);
      await client.connect(transport);
    }

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
