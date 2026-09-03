import { describe, expect, it, afterEach } from "vitest";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpClientManager } from "../../src/mcp/client-manager.js";

interface FixtureServer {
  url: string;
  close: () => Promise<void>;
}

/** A real (no-auth) Streamable HTTP MCP server, listening on an OS-assigned port. */
async function startEchoHttpServer(): Promise<FixtureServer> {
  const mcpServer = new Server({ name: "echo-http-fixture", version: "0.0.1" }, { capabilities: { tools: {} } });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echoes back the provided text",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
    ],
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const text = (request.params.arguments as { text?: string } | undefined)?.text ?? "";
    return { content: [{ type: "text", text: `echo: ${text}` }] };
  });

  // Stateless mode (sessionIdGenerator: undefined) has a bug in this SDK
  // version where the post-initialize "notifications/initialized" POST
  // 500s; stateful mode (a real per-connection session id) works correctly.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcpServer.connect(transport);

  const httpServer = http.createServer((req, res) => {
    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("McpClientManager (Streamable HTTP transport, no auth required)", () => {
  let manager: McpClientManager | undefined;
  let server: FixtureServer | undefined;

  afterEach(async () => {
    await manager?.disconnectAll();
    await server?.close();
    manager = undefined;
    server = undefined;
  });

  it("connects over HTTP, lists tools, and calls a tool through the wrapped ToolDefinition", async () => {
    server = await startEchoHttpServer();
    manager = new McpClientManager();

    await manager.connect({ name: "echo-http", transport: "http", url: server.url });
    expect(manager.connectedServers()).toEqual(["echo-http"]);

    const tools = await manager.listAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("mcp__echo-http__echo");
    expect(tools[0].riskLevel).toBe("ask");

    const result = await tools[0].handler(
      { text: "hello" },
      { cwd: process.cwd(), sessionId: "test", signal: new AbortController().signal },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("echo: hello");
  });

  it("throws a clear error when url is missing for an http server", async () => {
    manager = new McpClientManager();
    await expect(manager.connect({ name: "bad", transport: "http" })).rejects.toThrow(/requires "url"/);
  });
});
