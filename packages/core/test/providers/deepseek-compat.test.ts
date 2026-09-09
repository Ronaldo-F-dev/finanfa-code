import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAiCompatibleProvider } from "../../src/providers/openai-compatible-provider.js";

// Real, reported request: add DeepSeek support. DeepSeek's own pricing page
// states its OpenAI-format base URL as exactly "https://api.deepseek.com"
// (no /v1 suffix) — this project's OpenAiCompatibleProvider already
// implements the plain OpenAI chat-completions wire format, so the real
// question is purely whether the URL this project builds from that exact
// base URL (baseUrl + "/chat/completions") lands on the same path DeepSeek
// itself expects — not something to assume, verify against a real local
// HTTP server standing in for DeepSeek at that same "no /v1" shape.
describe("OpenAiCompatibleProvider against a DeepSeek-shaped base URL (real local HTTP server, no fetch mocking)", () => {
  it("POSTs to exactly <baseUrl>/chat/completions — no /v1, no other path segment — matching DeepSeek's documented base URL", async () => {
    let requestedPath: string | undefined;
    let requestedModel: string | undefined;
    const server = http.createServer((req, res) => {
      requestedPath = req.url;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requestedModel = (JSON.parse(body) as { model?: string }).model;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    const baseUrl = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    });

    try {
      // No /v1 in this baseUrl — deliberately matching DeepSeek's own
      // documented "https://api.deepseek.com" (also with no /v1).
      const provider = new OpenAiCompatibleProvider({ baseUrl, apiKey: "test-key" });
      let streamed = "";
      const result = await provider.streamTurn({
        model: "deepseek-v4-flash",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        onTextDelta: (t) => (streamed += t),
      });

      expect(requestedPath).toBe("/chat/completions");
      expect(requestedModel).toBe("deepseek-v4-flash");
      expect(streamed).toBe("ok");
      expect(result.stopReason).toBe("end_turn");
    } finally {
      server.close();
    }
  });
});
