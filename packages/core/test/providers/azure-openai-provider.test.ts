import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AzureOpenAiProvider } from "../../src/providers/azure-openai-provider.js";

describe("AzureOpenAiProvider.streamTurn (real local server, real OpenAI-compatible SSE — Azure's actual wire format)", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastRequest: { url: string; headers: http.IncomingHttpHeaders; body: unknown } | undefined;
  let responseEvents: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastRequest = { url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) };
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const e of responseEvents) res.write(`data: ${e}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("builds the real Azure deployment URL (with api-version) and uses 'api-key', not 'Authorization: Bearer'", async () => {
    responseEvents = [JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })];
    const provider = new AzureOpenAiProvider({ apiKey: "azure-key-123", endpoint: baseUrl, apiVersion: "2024-10-21" });

    const result = await provider.streamTurn({
      model: "my-gpt4o-deployment",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "say hi" }],
      tools: [],
      onTextDelta: () => {},
    });

    expect(lastRequest?.url).toBe("/openai/deployments/my-gpt4o-deployment/chat/completions?api-version=2024-10-21");
    expect(lastRequest?.headers["api-key"]).toBe("azure-key-123");
    expect(lastRequest?.headers.authorization).toBeUndefined();
    expect((lastRequest?.body as { messages: unknown[] } | undefined)?.messages).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "say hi" },
    ]);
    expect(result.assistantMessage.content).toBe("hi");
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1 });
    expect(result.stopReason).toBe("end_turn");
  });

  it("defaults to a stable api-version when none is given", async () => {
    responseEvents = [JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })];
    const provider = new AzureOpenAiProvider({ apiKey: "k", endpoint: baseUrl });
    await provider.streamTurn({ model: "dep", systemPrompt: "s", messages: [{ role: "user", content: "x" }], tools: [], onTextDelta: () => {} });
    expect(lastRequest?.url).toContain("api-version=2024-10-21");
  });

  it("streams real incremental text deltas via onTextDelta", async () => {
    responseEvents = [
      JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }),
    ];
    const provider = new AzureOpenAiProvider({ apiKey: "k", endpoint: baseUrl });
    let streamed = "";
    const result = await provider.streamTurn({ model: "dep", systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [], onTextDelta: (t) => (streamed += t) });
    expect(streamed).toBe("Hello");
    expect(result.assistantMessage.content).toBe("Hello");
  });

  it("reports a real tool call and stopReason 'tool_use'", async () => {
    responseEvents = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ];
    const provider = new AzureOpenAiProvider({ apiKey: "k", endpoint: baseUrl });
    const result = await provider.streamTurn({
      model: "dep",
      systemPrompt: "s",
      messages: [{ role: "user", content: "read a.txt" }],
      tools: [{ name: "read_file", description: "d", inputSchema: { type: "object" }, riskLevel: "safe", handler: async () => ({ content: "", isError: false }) }],
      onTextDelta: () => {},
    });
    expect(result.stopReason).toBe("tool_use");
    expect(result.assistantMessage.toolCalls).toEqual([{ id: "call_1", name: "read_file", input: { path: "a.txt" } }]);
  });
});
