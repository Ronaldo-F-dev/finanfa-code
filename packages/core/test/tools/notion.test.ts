import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createReadNotionPageTool, createWriteNotionPageTool, notionConfigFromEnv, readNotionPageBlocks, appendNotionParagraphs } from "../../src/tools/builtin/notion.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("read_notion_page / write_notion_page tools (real local HTTP server speaking Notion's API shape)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let lastRequest: { method: string | undefined; headers: http.IncomingHttpHeaders; body: string } | undefined;
  let responseOverride: { status: number; body: unknown } | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequest = { method: req.method, headers: req.headers, body };
        if (responseOverride) {
          res.writeHead(responseOverride.status, { "content-type": "application/json" });
          res.end(JSON.stringify(responseOverride.body));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (req.method === "GET") {
          res.end(
            JSON.stringify({
              results: [
                { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Hello " }, { plain_text: "world" }] } },
                { type: "heading_1", heading_1: { rich_text: [{ plain_text: "A heading" }] } },
                { type: "divider", divider: {} },
              ],
              has_more: false,
            }),
          );
        } else {
          res.end(JSON.stringify({ results: [] }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("read_notion_page flattens each block's rich_text to one line, skipping content-less blocks", async () => {
    const tool = createReadNotionPageTool({ apiKey: "secret_real-looking-token" }, apiBaseUrl);
    const result = await tool.handler({ page_id: "abc-123" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Hello world\nA heading");
    expect(lastRequest?.headers.authorization).toBe("Bearer secret_real-looking-token");
    expect(lastRequest?.headers["notion-version"]).toBe("2022-06-28");
  });

  it("read_notion_page notes when more content exists beyond what was fetched", async () => {
    responseOverride = { status: 200, body: { results: [], has_more: true } };
    const tool = createReadNotionPageTool({ apiKey: "secret" }, apiBaseUrl);
    const result = await tool.handler({ page_id: "abc-123" }, ctx);
    expect(result.content).toContain("more content exists beyond the first 100 blocks");
    responseOverride = undefined;
  });

  it("read_notion_page reports a real Notion API error", async () => {
    responseOverride = { status: 404, body: { message: "Could not find block with ID: abc-123." } };
    const tool = createReadNotionPageTool({ apiKey: "secret" }, apiBaseUrl);
    const result = await tool.handler({ page_id: "abc-123" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not find block with ID");
    responseOverride = undefined;
  });

  it("write_notion_page appends one paragraph block per line, via a real PATCH request", async () => {
    const tool = createWriteNotionPageTool({ apiKey: "secret" }, apiBaseUrl);
    const result = await tool.handler({ page_id: "abc-123", text: "first line\nsecond line" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Appended to Notion page abc-123");
    expect(lastRequest?.method).toBe("PATCH");
    const sentBody = JSON.parse(lastRequest!.body);
    expect(sentBody.children).toHaveLength(2);
    expect(sentBody.children[0]).toEqual({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "first line" } }] } });
  });

  it("reports a clear error when Notion is not configured, instead of throwing", async () => {
    const readTool = createReadNotionPageTool(undefined, apiBaseUrl);
    const readResult = await readTool.handler({ page_id: "abc-123" }, ctx);
    expect(readResult.isError).toBe(true);
    expect(readResult.content).toContain("Notion is not configured");

    const writeTool = createWriteNotionPageTool(undefined, apiBaseUrl);
    const writeResult = await writeTool.handler({ page_id: "abc-123", text: "hi" }, ctx);
    expect(writeResult.isError).toBe(true);
    expect(writeResult.content).toContain("Notion is not configured");
  });

  it("has the expected risk levels: safe to read, ask to write", () => {
    expect(createReadNotionPageTool({ apiKey: "x" }, apiBaseUrl).riskLevel).toBe("safe");
    expect(createWriteNotionPageTool({ apiKey: "x" }, apiBaseUrl).riskLevel).toBe("ask");
  });
});

describe("readNotionPageBlocks / appendNotionParagraphs retry behavior (real local HTTP server)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let requestCount: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
          res.end(JSON.stringify({ message: "rate limited" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.method === "GET" ? JSON.stringify({ results: [], has_more: false }) : JSON.stringify({}));
        void body;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("readNotionPageBlocks retries a real 429 (honoring Retry-After) and succeeds on the next attempt", async () => {
    requestCount = 0;
    const result = await readNotionPageBlocks({ apiKey: "x" }, "abc-123", apiBaseUrl);
    expect(result).toEqual({ ok: true, text: "", hasMore: false });
    expect(requestCount).toBe(2);
  });

  it("appendNotionParagraphs retries a real 429 (honoring Retry-After) and succeeds on the next attempt", async () => {
    requestCount = 0;
    const result = await appendNotionParagraphs({ apiKey: "x" }, "abc-123", "hi", apiBaseUrl);
    expect(result).toEqual({ ok: true });
    expect(requestCount).toBe(2);
  });
});

describe("notionConfigFromEnv", () => {
  it("returns undefined when NOTION_API_KEY is not set", () => {
    expect(notionConfigFromEnv({})).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(notionConfigFromEnv({ NOTION_API_KEY: "secret_abc" } as NodeJS.ProcessEnv)).toEqual({ apiKey: "secret_abc" });
  });
});
