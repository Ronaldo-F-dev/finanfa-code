#!/usr/bin/env node
// Minimal stdio MCP server used as a fixture in mcp/client-manager tests:
// exposes a single "echo" tool that returns its input back as text.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo-fixture", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echoes back the provided text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "echo") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  const text = request.params.arguments?.text ?? "";
  // Only appended when a test explicitly asks for it (via ECHO_ENV_PROBE),
  // so existing "echo: <text>" assertions elsewhere are untouched — this
  // lets a client-manager test prove a custom `env` config value actually
  // reached this spawned process, without changing default behavior.
  const probe = process.env.ECHO_ENV_PROBE;
  const suffix = probe ? ` env=${process.env[probe] ?? ""}` : "";
  return { content: [{ type: "text", text: `echo: ${text}${suffix}` }] };
});

await server.connect(new StdioServerTransport());
