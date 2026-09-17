import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createCreateTrelloCardTool, trelloConfigFromEnv, createTrelloCard } from "../../src/tools/builtin/trello.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("create_trello_card tool (real local HTTP server speaking Trello's API shape)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let lastRequest: { method: string | undefined; url: string | undefined } | undefined;
  let responseOverride: { status: number; body: string } | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        lastRequest = { method: req.method, url: req.url };
        if (responseOverride) {
          res.writeHead(responseOverride.status, { "content-type": "text/plain" });
          res.end(responseOverride.body);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "card123", shortUrl: "https://trello.com/c/card123" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("posts a real authenticated (key+token query param) request and reports success", async () => {
    const tool = createCreateTrelloCardTool({ apiKey: "real-looking-key", token: "real-looking-token" }, apiBaseUrl);
    const result = await tool.handler({ list_id: "list-1", name: "Ship the audit trail" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Created Trello card "Ship the audit trail"');
    expect(result.content).toContain("https://trello.com/c/card123");

    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.url).toContain("idList=list-1");
    expect(lastRequest?.url).toContain("key=real-looking-key");
    expect(lastRequest?.url).toContain("token=real-looking-token");
  });

  it("reports a real Trello error, including Trello's own plain-text (non-JSON) error bodies", async () => {
    responseOverride = { status: 401, body: "invalid key" };
    const tool = createCreateTrelloCardTool({ apiKey: "bad", token: "bad" }, apiBaseUrl);
    const result = await tool.handler({ list_id: "list-1", name: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toBe("invalid key");
    responseOverride = undefined;
  });

  it("reports a clear error when Trello is not configured, instead of throwing", async () => {
    const tool = createCreateTrelloCardTool(undefined, apiBaseUrl);
    const result = await tool.handler({ list_id: "list-1", name: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Trello is not configured");
  });

  it("has 'ask' risk level", () => {
    expect(createCreateTrelloCardTool({ apiKey: "x", token: "y" }, apiBaseUrl).riskLevel).toBe("ask");
  });
});

describe("createTrelloCard retry behavior (real local HTTP server)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let requestCount: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(429, { "content-type": "text/plain", "retry-after": "0" });
          res.end("rate limited");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "card1", url: "https://trello.com/c/card1" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("retries a real 429 (honoring Retry-After) and succeeds on the next attempt", async () => {
    requestCount = 0;
    const result = await createTrelloCard({ apiKey: "k", token: "t" }, { listId: "list-1", name: "x" }, apiBaseUrl);
    expect(result).toEqual({ ok: true, id: "card1", url: "https://trello.com/c/card1" });
    expect(requestCount).toBe(2);
  });
});

describe("trelloConfigFromEnv", () => {
  it("returns undefined when either TRELLO_API_KEY or TRELLO_API_TOKEN is missing", () => {
    expect(trelloConfigFromEnv({})).toBeUndefined();
    expect(trelloConfigFromEnv({ TRELLO_API_KEY: "k" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(trelloConfigFromEnv({ TRELLO_API_TOKEN: "t" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("builds a config from real env-var-shaped input", () => {
    expect(trelloConfigFromEnv({ TRELLO_API_KEY: "k", TRELLO_API_TOKEN: "t" } as NodeJS.ProcessEnv)).toEqual({ apiKey: "k", token: "t" });
  });
});
