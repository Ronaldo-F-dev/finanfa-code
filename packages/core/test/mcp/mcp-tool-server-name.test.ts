import { describe, expect, it } from "vitest";
import { mcpToolServerName } from "../../src/mcp/client-manager.js";

describe("mcpToolServerName", () => {
  it("extracts the server name from a namespaced MCP tool name", () => {
    expect(mcpToolServerName("mcp__github__list_issues")).toBe("github");
  });

  it("handles a tool name that itself contains double underscores", () => {
    expect(mcpToolServerName("mcp__notion__search__pages")).toBe("notion");
  });

  it("returns undefined for a built-in (non-namespaced) tool name", () => {
    expect(mcpToolServerName("read_file")).toBeUndefined();
  });

  it("returns undefined for a malformed mcp-prefixed name with no tool part", () => {
    expect(mcpToolServerName("mcp__github")).toBeUndefined();
  });
});
