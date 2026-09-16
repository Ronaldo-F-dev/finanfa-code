import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { GithubCopilotProvider } from "../../src/providers/github-copilot-provider.js";

describe("GithubCopilotProvider (real local HTTP servers standing in for api.github.com + api.githubcopilot.com)", () => {
  let githubApiServer: http.Server;
  let githubApiBaseUrl: string;
  let copilotApiServer: http.Server;
  let copilotApiBaseUrl: string;

  let tokenExchangeCount: number;
  let tokenExchangeAuthHeader: string | undefined;
  let copilotRequestHeaders: http.IncomingHttpHeaders | undefined;
  let copilotExpiresAt: number;

  beforeAll(async () => {
    githubApiServer = http.createServer((req, res) => {
      tokenExchangeCount++;
      tokenExchangeAuthHeader = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: `copilot-token-${tokenExchangeCount}`, expires_at: copilotExpiresAt }));
    });
    await new Promise<void>((resolve) => githubApiServer.listen(0, "127.0.0.1", resolve));
    githubApiBaseUrl = `http://127.0.0.1:${(githubApiServer.address() as AddressInfo).port}`;

    copilotApiServer = http.createServer((req, res) => {
      copilotRequestHeaders = req.headers;
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello from Copilot" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => copilotApiServer.listen(0, "127.0.0.1", resolve));
    copilotApiBaseUrl = `http://127.0.0.1:${(copilotApiServer.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    githubApiServer.close();
    copilotApiServer.close();
  });

  it("exchanges the GitHub token for a Copilot token, then streams a real chat completion with it", async () => {
    tokenExchangeCount = 0;
    copilotExpiresAt = Math.floor(Date.now() / 1000) + 3600;

    const provider = new GithubCopilotProvider({ githubToken: "gho_realtoken", githubApiBaseUrl, apiBaseUrl: copilotApiBaseUrl });
    let streamed = "";
    const result = await provider.streamTurn({
      model: "gpt-4o",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onTextDelta: (t) => (streamed += t),
    });

    expect(tokenExchangeAuthHeader).toBe("token gho_realtoken");
    expect(copilotRequestHeaders?.authorization).toBe("Bearer copilot-token-1");
    expect(copilotRequestHeaders?.["copilot-integration-id"]).toBe("vscode-chat");
    expect(streamed).toBe("Hello from Copilot");
    expect(result.assistantMessage.content).toBe("Hello from Copilot");
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 3 });
    expect(result.stopReason).toBe("end_turn");
  });

  it("reuses a cached Copilot token across calls instead of re-exchanging every time", async () => {
    tokenExchangeCount = 0;
    copilotExpiresAt = Math.floor(Date.now() / 1000) + 3600;

    const provider = new GithubCopilotProvider({ githubToken: "gho_realtoken", githubApiBaseUrl, apiBaseUrl: copilotApiBaseUrl });
    await provider.streamTurn({ model: "gpt-4o", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} });
    await provider.streamTurn({ model: "gpt-4o", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} });

    expect(tokenExchangeCount).toBe(1);
  });

  it("re-exchanges once the cached token is close to expiring", async () => {
    tokenExchangeCount = 0;
    copilotExpiresAt = Math.floor(Date.now() / 1000) + 30; // inside the 60s refresh margin

    const provider = new GithubCopilotProvider({ githubToken: "gho_realtoken", githubApiBaseUrl, apiBaseUrl: copilotApiBaseUrl });
    await provider.streamTurn({ model: "gpt-4o", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} });
    await provider.streamTurn({ model: "gpt-4o", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} });

    expect(tokenExchangeCount).toBe(2);
  });

  it("reports a clear error when the token exchange itself fails", async () => {
    const failingServer = http.createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Bad credentials" }));
    });
    await new Promise<void>((resolve) => failingServer.listen(0, "127.0.0.1", resolve));
    const failingBaseUrl = `http://127.0.0.1:${(failingServer.address() as AddressInfo).port}`;

    try {
      const provider = new GithubCopilotProvider({ githubToken: "bad-token", githubApiBaseUrl: failingBaseUrl, apiBaseUrl: copilotApiBaseUrl });
      await expect(
        provider.streamTurn({ model: "gpt-4o", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} }),
      ).rejects.toThrow(/Failed to exchange the GitHub token/);
    } finally {
      failingServer.close();
    }
  });
});
