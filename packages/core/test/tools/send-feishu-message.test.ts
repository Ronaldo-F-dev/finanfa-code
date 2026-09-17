import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createSendFeishuMessageTool, feishuConfigFromEnv, postFeishuMessage } from "../../src/tools/builtin/send-feishu-message.js";
import { resetFeishuTokenCacheForTests } from "../../src/core/feishu-token.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("send_feishu_message tool (real local HTTP server speaking Feishu's auth + IM API shapes)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let lastSendRequest: { url: string; authHeader: string | undefined; body: string } | undefined;
  let shouldError = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/open-apis/auth/v3/tenant_access_token/internal") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "real-looking-tenant-token", expire: 7200 }));
          return;
        }
        lastSendRequest = { url: req.url ?? "", authHeader: req.headers.authorization, body };
        res.writeHead(200, { "content-type": "application/json" });
        if (shouldError) {
          res.end(JSON.stringify({ code: 99991400, msg: "param invalid: receive_id" }));
        } else {
          res.end(JSON.stringify({ code: 0, msg: "ok", data: { message_id: "om_1" } }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    resetFeishuTokenCacheForTests();
    shouldError = false;
  });

  it("fetches a real tenant_access_token, then posts a real send-message request authenticated with it", async () => {
    const tool = createSendFeishuMessageTool({ appId: "cli_real", appSecret: "s" }, apiBaseUrl);
    const result = await tool.handler({ chatId: "oc_123", text: "Hello from finanfa-code" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Message sent to oc_123");

    expect(lastSendRequest?.url).toBe("/open-apis/im/v1/messages?receive_id_type=chat_id");
    expect(lastSendRequest?.authHeader).toBe("Bearer real-looking-tenant-token");
    expect(JSON.parse(lastSendRequest!.body)).toEqual({ receive_id: "oc_123", msg_type: "text", content: JSON.stringify({ text: "Hello from finanfa-code" }) });
  });

  it("reports a real Feishu API error (nonzero code) as a tool error", async () => {
    shouldError = true;
    const tool = createSendFeishuMessageTool({ appId: "cli_real", appSecret: "s" }, apiBaseUrl);
    const result = await tool.handler({ chatId: "invalid", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("param invalid: receive_id");
  });

  it("reports a clear error when Feishu is not configured, instead of throwing", async () => {
    const tool = createSendFeishuMessageTool(undefined, apiBaseUrl);
    const result = await tool.handler({ chatId: "oc_123", text: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Feishu is not configured");
  });

  it("has 'ask' risk level", () => {
    expect(createSendFeishuMessageTool({ appId: "a", appSecret: "s" }, apiBaseUrl).riskLevel).toBe("ask");
  });
});

describe("postFeishuMessage retry behavior (real local HTTP server)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let sendRequestCount: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        if (req.url === "/open-apis/auth/v3/tenant_access_token/internal") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "t", expire: 7200 }));
          return;
        }
        sendRequestCount++;
        if (sendRequestCount === 1) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: 1, msg: "internal error" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, msg: "ok" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    resetFeishuTokenCacheForTests();
    sendRequestCount = 0;
  });

  it("retries a real 5xx on the send-message call and succeeds on the next attempt", async () => {
    const result = await postFeishuMessage({ appId: "a", appSecret: "s" }, { chatId: "oc_1", text: "hi" }, apiBaseUrl);
    expect(result).toEqual({ ok: true });
    expect(sendRequestCount).toBe(2);
  });
});

describe("feishuConfigFromEnv", () => {
  it("returns undefined when either FEISHU_APP_ID or FEISHU_APP_SECRET is missing", () => {
    expect(feishuConfigFromEnv({})).toBeUndefined();
    expect(feishuConfigFromEnv({ FEISHU_APP_ID: "a" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(feishuConfigFromEnv({ FEISHU_APP_SECRET: "s" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(feishuConfigFromEnv({ FEISHU_APP_ID: "a", FEISHU_APP_SECRET: "s" } as NodeJS.ProcessEnv)).toEqual({ appId: "a", appSecret: "s" });
  });
});
