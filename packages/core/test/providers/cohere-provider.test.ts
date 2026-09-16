import { describe, expect, it } from "vitest";
import { toCohereMessages, toCohereTools, CohereProvider } from "../../src/providers/cohere-provider.js";
import type { NeutralMessage, ToolDefinition } from "../../src/core/types.js";
import http from "node:http";
import type { AddressInfo } from "node:net";

describe("cohere-provider conversions", () => {
  it("puts the system prompt as its own first message", () => {
    expect(toCohereMessages("be helpful", [{ role: "user", content: "hi" }])).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
    ]);
  });

  it("converts an assistant message with tool calls, JSON-stringifying each call's input", () => {
    const neutral: NeutralMessage[] = [
      { role: "assistant", content: "let me check", toolCalls: [{ id: "t1", name: "read_file", input: { path: "a.txt" } }] },
    ];
    expect(toCohereMessages("s", neutral)).toEqual([
      { role: "system", content: "s" },
      { role: "assistant", content: "let me check", toolCalls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
    ]);
  });

  it("converts a tool-result message into one 'tool' message per result, keyed by toolCallId", () => {
    const neutral: NeutralMessage[] = [
      { role: "tool", results: [{ toolCallId: "t1", content: "file contents", isError: false }] },
    ];
    expect(toCohereMessages("s", neutral)).toEqual([
      { role: "system", content: "s" },
      { role: "tool", toolCallId: "t1", content: "file contents" },
    ]);
  });

  it("converts tool definitions to Cohere's function-tool shape", () => {
    const tools: ToolDefinition[] = [
      { name: "read_file", description: "reads a file", riskLevel: "safe", inputSchema: { type: "object", properties: { path: { type: "string" } } }, describeCall: () => "", async handler() { return { content: "", isError: false }; } },
    ];
    expect(toCohereTools(tools)).toEqual([
      { type: "function", function: { name: "read_file", description: "reads a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    ]);
  });
});

describe("CohereProvider.streamTurn (real cohere-ai SDK, real local HTTP server speaking Cohere's v2/chat SSE shape)", () => {
  function sseLine(event: unknown): string {
    return `data: ${JSON.stringify(event)}\n\n`;
  }

  it("streams text deltas and reports usage/stopReason from message-end", async () => {
    let requestBody: { model: string; messages: unknown[] } | undefined;
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        requestBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseLine({ type: "content-delta", index: 0, delta: { message: { content: { text: "Hello" } } } }));
        res.write(sseLine({ type: "content-delta", index: 0, delta: { message: { content: { text: " world" } } } }));
        res.write(sseLine({ type: "message-end", delta: { finishReason: "COMPLETE", usage: { tokens: { inputTokens: 12, outputTokens: 3 } } } }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const provider = new CohereProvider("test-key", baseUrl);
      let streamed = "";
      const result = await provider.streamTurn({
        model: "command-a-plus",
        systemPrompt: "be helpful",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        onTextDelta: (t) => (streamed += t),
      });

      expect(streamed).toBe("Hello world");
      expect(result.assistantMessage).toEqual({ role: "assistant", content: "Hello world", toolCalls: undefined });
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
      expect(result.stopReason).toBe("end_turn");
      expect(requestBody?.model).toBe("command-a-plus");
    } finally {
      server.close();
    }
  });

  it("assembles a streamed tool call from tool-call-start + tool-call-delta events, real accumulated JSON arguments", async () => {
    const server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseLine({ type: "tool-call-start", index: 0, delta: { message: { toolCalls: { id: "call_1", type: "function", function: { name: "read_file", arguments: "" } } } } }));
        res.write(sseLine({ type: "tool-call-delta", index: 0, delta: { message: { toolCalls: { function: { arguments: '{"path":' } } } } }));
        res.write(sseLine({ type: "tool-call-delta", index: 0, delta: { message: { toolCalls: { function: { arguments: '"a.txt"}' } } } } }));
        res.write(sseLine({ type: "message-end", delta: { finishReason: "TOOL_CALL", usage: { tokens: { inputTokens: 5, outputTokens: 5 } } } }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const provider = new CohereProvider("test-key", baseUrl);
      const result = await provider.streamTurn({
        model: "command-a-plus",
        systemPrompt: "s",
        messages: [{ role: "user", content: "read a.txt" }],
        tools: [],
        onTextDelta: () => {},
      });

      expect(result.assistantMessage.toolCalls).toEqual([{ id: "call_1", name: "read_file", input: { path: "a.txt" } }]);
      expect(result.stopReason).toBe("tool_use");
    } finally {
      server.close();
    }
  });
});
