import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createSendTelegramMessageTool, telegramConfigFromEnv, postTelegramMessage } from "../../src/tools/builtin/send-telegram-message.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("send_telegram_message tool (real local HTTP server speaking Telegram's sendMessage shape)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let lastRequest: { url: string; body: string } | undefined;
  let shouldError = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequest = { url: req.url ?? "", body };
        res.writeHead(200, { "content-type": "application/json" });
        if (shouldError) {
          res.end(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }));
        } else {
          res.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    apiBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("posts a real request to the right bot-token URL and reports success", async () => {
    const tool = createSendTelegramMessageTool({ botToken: "123:ABC-real-looking-token" }, apiBaseUrl);
    const result = await tool.handler({ chatId: "12345", text: "Hello from finanfa-code" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Message sent to 12345");
    expect(result.content).toContain("42");

    expect(lastRequest?.url).toBe("/bot123:ABC-real-looking-token/sendMessage");
    expect(JSON.parse(lastRequest!.body)).toMatchObject({ chat_id: "12345", text: "Hello from finanfa-code" });
  });

  it("reports a Telegram-level rejection (ok:false) as a tool error with the real description", async () => {
    shouldError = true;
    const tool = createSendTelegramMessageTool({ botToken: "123:ABC" }, apiBaseUrl);
    const result = await tool.handler({ chatId: "99999", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("chat not found");
    shouldError = false;
  });

  it("reports a clear error when Telegram is not configured, instead of throwing", async () => {
    const tool = createSendTelegramMessageTool(undefined, apiBaseUrl);
    const result = await tool.handler({ chatId: "12345", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Telegram is not configured");
  });

  it("has 'ask' risk level", () => {
    expect(createSendTelegramMessageTool({ botToken: "x" }, apiBaseUrl).riskLevel).toBe("ask");
  });
});

describe("postTelegramMessage retry behavior (real local HTTP server)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let requestCount: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(429, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests: retry after 0", parameters: { retry_after: 0 } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("retries a real 429 (honoring parameters.retry_after) and succeeds on the next attempt", async () => {
    requestCount = 0;
    const result = await postTelegramMessage({ botToken: "123:test" }, { chatId: "1", text: "hi" }, apiBaseUrl);
    expect(result).toEqual({ ok: true, messageId: 1 });
    expect(requestCount).toBe(2);
  });
});

describe("telegramConfigFromEnv", () => {
  it("returns undefined when TELEGRAM_BOT_TOKEN is not set", () => {
    expect(telegramConfigFromEnv({})).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: "123:abc" } as NodeJS.ProcessEnv)).toEqual({ botToken: "123:abc" });
  });
});
