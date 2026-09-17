import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getFeishuTenantAccessToken, resetFeishuTokenCacheForTests } from "../../src/core/feishu-token.js";

describe("getFeishuTenantAccessToken (real local HTTP server speaking Feishu's auth API shape)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let requestCount: number;
  let lastRequestBody: string | undefined;
  let expireSeconds: number;
  let shouldError = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requestCount++;
        lastRequestBody = body;
        if (shouldError) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: 10003, msg: "invalid app_secret" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: `t-${requestCount}`, expire: expireSeconds }));
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
    requestCount = 0;
    expireSeconds = 7200;
    shouldError = false;
  });

  it("fetches a real token with the real app_id/app_secret in the request body", async () => {
    const result = await getFeishuTenantAccessToken({ appId: "cli_real", appSecret: "real-secret" }, apiBaseUrl);
    expect(result).toEqual({ ok: true, token: "t-1" });
    expect(JSON.parse(lastRequestBody!)).toEqual({ app_id: "cli_real", app_secret: "real-secret" });
  });

  it("caches the token — a second call within its real expiry doesn't fetch again", async () => {
    const first = await getFeishuTenantAccessToken({ appId: "cli_real", appSecret: "s" }, apiBaseUrl);
    const second = await getFeishuTenantAccessToken({ appId: "cli_real", appSecret: "s" }, apiBaseUrl);
    expect(first).toEqual(second);
    expect(requestCount).toBe(1);
  });

  it("fetches a fresh token once the cached one is past its real expiry (safety margin included)", async () => {
    expireSeconds = 1; // expires almost immediately, well within the safety margin
    await getFeishuTenantAccessToken({ appId: "cli_real", appSecret: "s" }, apiBaseUrl);
    expect(requestCount).toBe(1);

    const second = await getFeishuTenantAccessToken({ appId: "cli_real", appSecret: "s" }, apiBaseUrl);
    expect(second).toEqual({ ok: true, token: "t-2" });
    expect(requestCount).toBe(2);
  });

  it("caches independently per app_id", async () => {
    await getFeishuTenantAccessToken({ appId: "app-a", appSecret: "s" }, apiBaseUrl);
    await getFeishuTenantAccessToken({ appId: "app-b", appSecret: "s" }, apiBaseUrl);
    expect(requestCount).toBe(2);
  });

  it("reports a real Feishu auth error instead of throwing", async () => {
    shouldError = true;
    const result = await getFeishuTenantAccessToken({ appId: "cli_real", appSecret: "wrong" }, apiBaseUrl);
    expect(result).toEqual({ ok: false, error: "invalid app_secret" });
  });
});
