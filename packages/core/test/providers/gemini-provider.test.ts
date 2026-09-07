import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { GeminiProvider, toGeminiContents, toGeminiTools, parseSseEvents } from "../../src/providers/gemini-provider.js";
import type { NeutralMessage, ToolDefinition } from "../../src/core/types.js";

describe("toGeminiContents (pure conversion)", () => {
  it("maps a plain user turn", () => {
    const messages: NeutralMessage[] = [{ role: "user", content: "hi" }];
    expect(toGeminiContents(messages)).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("maps an assistant turn with a tool call into a functionCall part, using 'model' role", () => {
    const messages: NeutralMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", input: { path: "a.txt" } }] },
    ];
    expect(toGeminiContents(messages)).toEqual([{ role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "a.txt" } } }] }]);
  });

  it("correlates a tool result back to its function name (Gemini has no call-id concept) via the preceding assistant message", () => {
    const messages: NeutralMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", input: {} }] },
      { role: "tool", results: [{ toolCallId: "call_1", content: "file contents", isError: false }] },
    ];
    const contents = toGeminiContents(messages);
    expect(contents[1]).toEqual({ role: "user", parts: [{ functionResponse: { name: "read_file", response: { result: "file contents" } } }] });
  });

  it("wraps an error tool result as {error: ...} instead of {result: ...}", () => {
    const messages: NeutralMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "bash", input: {} }] },
      { role: "tool", results: [{ toolCallId: "call_1", content: "command not found", isError: true }] },
    ];
    const contents = toGeminiContents(messages);
    expect(contents[1].parts[0]).toEqual({ functionResponse: { name: "bash", response: { error: "command not found" } } });
  });
});

describe("toGeminiTools (pure conversion)", () => {
  it("converts a ToolDefinition into a functionDeclarations entry", () => {
    const tools: ToolDefinition[] = [{ name: "read_file", description: "reads a file", inputSchema: { type: "object", properties: { path: { type: "string" } } }, riskLevel: "safe", handler: async () => ({ content: "", isError: false }) }];
    expect(toGeminiTools(tools)).toEqual([{ functionDeclarations: [{ name: "read_file", description: "reads a file", parameters: tools[0]!.inputSchema }] }]);
  });

  it("returns undefined for an empty tool list", () => {
    expect(toGeminiTools([])).toBeUndefined();
  });
});

describe("parseSseEvents (pure SSE framing)", () => {
  it("parses a single-line event terminated by a blank line", () => {
    const buffer: string[] = [];
    const { events, remainder } = parseSseEvents('data: {"a":1}\n\n', buffer);
    expect(events).toEqual(['{"a":1}']);
    expect(remainder).toBe("");
  });

  it("joins a real pretty-printed, multi-line event's data: lines before the blank-line boundary (the documented Gemini SSE gotcha)", () => {
    const buffer: string[] = [];
    const chunk = 'data: {\ndata:   "a": 1,\ndata:   "b": 2\ndata: }\n\n';
    const { events } = parseSseEvents(chunk, buffer);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!)).toEqual({ a: 1, b: 2 });
  });

  it("buffers a partial event across two chunks (real streaming can split mid-event)", () => {
    const buffer: string[] = [];
    const first = parseSseEvents('data: {"a":1', buffer);
    expect(first.events).toHaveLength(0);
    const second = parseSseEvents(first.remainder + '}\n\n', buffer);
    expect(second.events).toEqual(['{"a":1}']);
  });

  it("parses two separate events in one chunk", () => {
    const buffer: string[] = [];
    const { events } = parseSseEvents('data: {"a":1}\n\ndata: {"b":2}\n\n', buffer);
    expect(events).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("GeminiProvider.streamTurn (real local HTTP server, real Gemini-shaped SSE)", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastRequest: { url: string; body: unknown } | undefined;
  let responseScript: (res: http.ServerResponse) => void = () => {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastRequest = { url: req.url ?? "", body: JSON.parse(raw) };
        res.writeHead(200, { "content-type": "text/event-stream" });
        responseScript(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("builds the real request URL with model + API key as a query param, and the real request body shape", async () => {
    responseScript = (res) => {
      res.write('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}\n\n');
      res.end();
    };
    const provider = new GeminiProvider({ apiKey: "test-key-123", baseUrl });
    const streamed: string[] = [];
    const result = await provider.streamTurn({
      model: "gemini-2.5-flash",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "say hi" }],
      tools: [],
      onTextDelta: (t) => streamed.push(t),
    });

    expect(lastRequest?.url).toContain("/v1beta/models/gemini-2.5-flash:streamGenerateContent");
    expect(lastRequest?.url).toContain("alt=sse");
    expect(lastRequest?.url).toContain("key=test-key-123");
    expect(lastRequest?.body).toMatchObject({
      systemInstruction: { parts: [{ text: "be helpful" }] },
      contents: [{ role: "user", parts: [{ text: "say hi" }] }],
    });

    expect(streamed.join("")).toBe("hi");
    expect(result.assistantMessage.content).toBe("hi");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(result.stopReason).toBe("end_turn");
  });

  it("streams real incremental text across multiple SSE events and accumulates it", async () => {
    responseScript = (res) => {
      res.write('data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n');
      res.write('data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n');
      res.end();
    };
    const provider = new GeminiProvider({ apiKey: "k", baseUrl });
    let streamed = "";
    const result = await provider.streamTurn({
      model: "gemini-2.5-flash",
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onTextDelta: (t) => (streamed += t),
    });
    expect(streamed).toBe("Hello");
    expect(result.assistantMessage.content).toBe("Hello");
  });

  it("parses a real functionCall part into a tool call and reports stopReason 'tool_use'", async () => {
    responseScript = (res) => {
      res.write('data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.txt"}}}]},"finishReason":"STOP"}]}\n\n');
      res.end();
    };
    const provider = new GeminiProvider({ apiKey: "k", baseUrl });
    const result = await provider.streamTurn({
      model: "gemini-2.5-flash",
      systemPrompt: "s",
      messages: [{ role: "user", content: "read a.txt" }],
      tools: [{ name: "read_file", description: "reads a file", inputSchema: { type: "object" }, riskLevel: "safe", handler: async () => ({ content: "", isError: false }) }],
      onTextDelta: () => {},
    });
    expect(result.stopReason).toBe("tool_use");
    expect(result.assistantMessage.toolCalls).toEqual([expect.objectContaining({ name: "read_file", input: { path: "a.txt" } })]);
  });

  it("handles a real multi-line (pretty-printed) SSE event the same as a single-line one", async () => {
    responseScript = (res) => {
      res.write('data: {\ndata:   "candidates": [{\ndata:     "content": {"parts": [{"text": "spread out"}]},\ndata:     "finishReason": "STOP"\ndata:   }]\ndata: }\n\n');
      res.end();
    };
    const provider = new GeminiProvider({ apiKey: "k", baseUrl });
    let streamed = "";
    const result = await provider.streamTurn({
      model: "gemini-2.5-flash",
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onTextDelta: (t) => (streamed += t),
    });
    expect(streamed).toBe("spread out");
    expect(result.assistantMessage.content).toBe("spread out");
  });

  it("throws a real, informative error for a non-OK HTTP response", async () => {
    responseScript = () => {}; // overridden below via a dedicated non-OK server
    const badServer = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "API key not valid" } }));
      });
    });
    await new Promise<void>((resolve) => badServer.listen(0, "127.0.0.1", resolve));
    const port = (badServer.address() as AddressInfo).port;

    const provider = new GeminiProvider({ apiKey: "bad-key", baseUrl: `http://127.0.0.1:${port}` });
    await expect(
      provider.streamTurn({ model: "gemini-2.5-flash", systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [], onTextDelta: () => {} }),
    ).rejects.toThrow(/Gemini API error \(400\)/);

    badServer.close();
  });
});
