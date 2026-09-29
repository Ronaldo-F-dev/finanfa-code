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

  it("merges a stdio server's `env` config on top of the default environment, rather than replacing it", async () => {
    manager = new McpClientManager();
    // If `env` replaced the default environment instead of merging onto it,
    // PATH would be gone and process.execPath (an absolute path, so it
    // doesn't need PATH to be found) plus the fixture's own reliance on
    // node's module resolution would still start — so this also asserts on
    // the actual custom value round-tripping through, not just "it started".
    await manager.connect({
      name: "echo",
      transport: "stdio",
      command: process.execPath,
      args: [fixtureServer],
      env: { ECHO_ENV_PROBE: "CUSTOM_SECRET", CUSTOM_SECRET: "sk-test-123" },
    });

    const tools = await manager.listAllTools();
    const result = await tools[0].handler({ text: "hi" }, {
      cwd: process.cwd(),
      sessionId: "test",
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("echo: hi env=sk-test-123");
  });
});
