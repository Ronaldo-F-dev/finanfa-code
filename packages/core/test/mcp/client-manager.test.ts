import { describe, expect, it, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClientManager } from "../../src/mcp/client-manager.js";

const fixtureServer = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/echo-mcp-server.mjs",
);

describe("McpClientManager (end-to-end against a real stdio MCP server)", () => {
  let manager: McpClientManager;

  afterEach(async () => {
    await manager?.disconnectAll();
  });

  it("connects, lists tools, and calls a tool through the wrapped ToolDefinition", async () => {
    manager = new McpClientManager();
    await manager.connect({ name: "echo", transport: "stdio", command: process.execPath, args: [fixtureServer] });

    expect(manager.connectedServers()).toEqual(["echo"]);

    const tools = await manager.listAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("mcp__echo__echo");
    expect(tools[0].riskLevel).toBe("ask");

    const result = await tools[0].handler({ text: "hello" }, {
      cwd: process.cwd(),
      sessionId: "test",
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("echo: hello");
  });
});
