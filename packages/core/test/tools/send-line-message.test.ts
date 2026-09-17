import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createSendLineMessageTool, lineConfigFromEnv, postLineMessage } from "../../src/tools/builtin/send-line-message.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("send_line_message tool (real local HTTP server speaking LINE's push API shape)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let lastRequest: { url: string; authHeader: string | undefined; body: string } | undefined;
  let shouldError = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequest = { url: req.url ?? "", authHeader: req.headers.authorization, body };
        if (shouldError) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "The property, 'to', in the request body is invalid" }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("posts a real push request with the real Bearer token and reports success", async () => {
    const tool = createSendLineMessageTool({ channelAccessToken: "real-looking-token" }, apiBaseUrl);
    const result = await tool.handler({ to: "U123", text: "Hello from finanfa-code" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Message sent to U123");

    expect(lastRequest?.url).toBe("/v2/bot/message/push");
    expect(lastRequest?.authHeader).toBe("Bearer real-looking-token");
    expect(JSON.parse(lastRequest!.body)).toEqual({ to: "U123", messages: [{ type: "text", text: "Hello from finanfa-code" }] });
  });

  it("reports a real LINE API error as a tool error with the real message", async () => {
    shouldError = true;
    const tool = createSendLineMessageTool({ channelAccessToken: "t" }, apiBaseUrl);
    const result = await tool.handler({ to: "invalid", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("'to', in the request body is invalid");
    shouldError = false;
  });

  it("reports a clear error when LINE is not configured, instead of throwing", async () => {
    const tool = createSendLineMessageTool(undefined, apiBaseUrl);
    const result = await tool.handler({ to: "U123", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("LINE is not configured");
  });

  it("has 'ask' risk level", () => {
    expect(createSendLineMessageTool({ channelAccessToken: "x" }, apiBaseUrl).riskLevel).toBe("ask");
  });
});

describe("postLineMessage retry behavior (real local HTTP server)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let requestCount: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "internal error" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("retries a real 5xx and succeeds on the next attempt", async () => {
    requestCount = 0;
    const result = await postLineMessage({ channelAccessToken: "t" }, { to: "U1", text: "hi" }, apiBaseUrl);
    expect(result).toEqual({ ok: true });
    expect(requestCount).toBe(2);
  });
});

describe("lineConfigFromEnv", () => {
  it("returns undefined when LINE_CHANNEL_ACCESS_TOKEN is not set", () => {
    expect(lineConfigFromEnv({})).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(lineConfigFromEnv({ LINE_CHANNEL_ACCESS_TOKEN: "abc" } as NodeJS.ProcessEnv)).toEqual({ channelAccessToken: "abc" });
  });
});
