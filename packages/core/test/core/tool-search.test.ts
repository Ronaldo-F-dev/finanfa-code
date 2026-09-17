import { describe, expect, it } from "vitest";
import { rankToolsByQuery, createToolSearchMetaTools, createCallToolMetaTool, SEARCH_TOOLS_NAME, DESCRIBE_TOOL_NAME, CALL_TOOL_NAME } from "../../src/core/tool-search.js";
import type { ToolDefinition } from "../../src/core/types.js";

function tool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      return { content: "", isError: false };
    },
  };
}

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("rankToolsByQuery (real BM25 over name+description)", () => {
  const tools = [
    tool("bash", "Run a shell command in the project's sandbox"),
    tool("read_file", "Read a file's contents from the project"),
    tool("write_file", "Write content to a file in the project"),
    tool("web_search", "Search the web for current information"),
    tool("send_slack_message", "Send a real message to a Slack channel"),
  ];

  it("ranks a tool whose name/description matches the query above unrelated ones", () => {
    const hits = rankToolsByQuery(tools, "run a shell command", 5);
    expect(hits[0]?.tool.name).toBe("bash");
  });

  it("matches on the query 'search the web'", () => {
    const hits = rankToolsByQuery(tools, "search the web", 5);
    expect(hits[0]?.tool.name).toBe("web_search");
  });

  it("returns an empty array (not a random fallback) when nothing matches at all", () => {
    expect(rankToolsByQuery(tools, "xyzzy plugh quux", 5)).toEqual([]);
  });

  it("returns an empty array for an empty query instead of every tool", () => {
    expect(rankToolsByQuery(tools, "", 5)).toEqual([]);
  });

  it("respects the given limit", () => {
    const manyTools = Array.from({ length: 20 }, (_, i) => tool(`file_tool_${i}`, "read or write a file in the project"));
    const hits = rankToolsByQuery(manyTools, "file", 3);
    expect(hits).toHaveLength(3);
  });

  it("caps the limit even when a larger one is requested", () => {
    const manyTools = Array.from({ length: 30 }, (_, i) => tool(`file_tool_${i}`, "read or write a file in the project"));
    const hits = rankToolsByQuery(manyTools, "file", 1000);
    expect(hits.length).toBeLessThanOrEqual(20);
  });

  it("handles an empty tool list without throwing", () => {
    expect(rankToolsByQuery([], "anything", 5)).toEqual([]);
  });
});

describe("createToolSearchMetaTools", () => {
  const tools = [tool("bash", "Run a shell command"), tool("read_file", "Read a file's contents")];

  it("search_tools reports matching tools ranked by relevance", async () => {
    const [searchTools] = createToolSearchMetaTools(() => tools);
    const result = await searchTools.handler({ query: "shell command" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("bash");
  });

  it("search_tools reports plainly when nothing matches", async () => {
    const [searchTools] = createToolSearchMetaTools(() => tools);
    const result = await searchTools.handler({ query: "completely unrelated gibberish" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No tool matched");
  });

  it("search_tools reflects the LIVE available-tools getter, not a fixed snapshot", async () => {
    let currentTools = tools;
    const [searchTools] = createToolSearchMetaTools(() => currentTools);
    currentTools = [...tools, tool("send_email", "Send a real email")];
    const result = await searchTools.handler({ query: "email" }, ctx);
    expect(result.content).toContain("send_email");
  });

  it("describe_tool reports a tool's full schema/riskLevel by name", async () => {
    const [, describeTool] = createToolSearchMetaTools(() => tools);
    const result = await describeTool.handler({ name: "bash" }, ctx);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed).toMatchObject({ name: "bash", riskLevel: "safe" });
  });

  it("describe_tool reports a clear error for an unknown tool name", async () => {
    const [, describeTool] = createToolSearchMetaTools(() => tools);
    const result = await describeTool.handler({ name: "nonexistent_tool" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(SEARCH_TOOLS_NAME);
  });

  it("both meta-tools have 'safe' risk level (read-only, no side effects)", () => {
    const [searchTools, describeTool] = createToolSearchMetaTools(() => tools);
    expect(searchTools.riskLevel).toBe("safe");
    expect(describeTool.riskLevel).toBe("safe");
  });

  it("uses the expected fixed names", () => {
    const [searchTools, describeTool] = createToolSearchMetaTools(() => tools);
    expect(searchTools.name).toBe(SEARCH_TOOLS_NAME);
    expect(describeTool.name).toBe(DESCRIBE_TOOL_NAME);
  });
});

describe("createCallToolMetaTool", () => {
  it("has the expected fixed name and 'safe' declared risk level (the REAL target tool's own riskLevel is what actually gates confirmation, applied by loop.ts's interception)", () => {
    const callTool = createCallToolMetaTool();
    expect(callTool.name).toBe(CALL_TOOL_NAME);
    expect(callTool.riskLevel).toBe("safe");
  });

  it("its own handler throws if ever actually invoked directly — it must be intercepted before dispatch, never run as-is", async () => {
    const callTool = createCallToolMetaTool();
    await expect(callTool.handler({ name: "bash" }, ctx)).rejects.toThrow(/intercepted/);
  });
});
