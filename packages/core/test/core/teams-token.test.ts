import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getTeamsAccessToken, resetTeamsTokenCacheForTests } from "../../src/core/teams-token.js";

describe("getTeamsAccessToken (real local HTTP server speaking Microsoft's OAuth2 token endpoint shape)", () => {
  let server: http.Server;
  let tokenUrl: string;
  let requestCount: number;
  let lastRequestBody: string | undefined;
  let expiresIn: number;
  let shouldError = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requestCount++;
        lastRequestBody = body;
        if (shouldError) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_client", error_description: "Invalid client secret provided." }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `tok-${requestCount}`, expires_in: expiresIn, token_type: "Bearer" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    resetTeamsTokenCacheForTests();
    requestCount = 0;
    expiresIn = 3600;
    shouldError = false;
  });

  it("fetches a real token with the real client_credentials grant in the request body", async () => {
    const result = await getTeamsAccessToken({ appId: "app-1", appPassword: "secret" }, tokenUrl);
    expect(result).toEqual({ ok: true, token: "tok-1" });
    const params = new URLSearchParams(lastRequestBody);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("app-1");
    expect(params.get("client_secret")).toBe("secret");
    expect(params.get("scope")).toBe("https://api.botframework.com/.default");
  });

  it("caches the token — a second call within its real expiry doesn't fetch again", async () => {
    const first = await getTeamsAccessToken({ appId: "app-1", appPassword: "s" }, tokenUrl);
    const second = await getTeamsAccessToken({ appId: "app-1", appPassword: "s" }, tokenUrl);
    expect(first).toEqual(second);
    expect(requestCount).toBe(1);
  });

  it("fetches a fresh token once the cached one is past its real expiry (safety margin included)", async () => {
    expiresIn = 1;
    await getTeamsAccessToken({ appId: "app-1", appPassword: "s" }, tokenUrl);
    expect(requestCount).toBe(1);

    const second = await getTeamsAccessToken({ appId: "app-1", appPassword: "s" }, tokenUrl);
    expect(second).toEqual({ ok: true, token: "tok-2" });
    expect(requestCount).toBe(2);
  });

  it("caches independently per app_id", async () => {
    await getTeamsAccessToken({ appId: "app-a", appPassword: "s" }, tokenUrl);
    await getTeamsAccessToken({ appId: "app-b", appPassword: "s" }, tokenUrl);
    expect(requestCount).toBe(2);
  });

  it("reports a real Microsoft OAuth2 error instead of throwing", async () => {
    shouldError = true;
    const result = await getTeamsAccessToken({ appId: "app-1", appPassword: "wrong" }, tokenUrl);
    expect(result).toEqual({ ok: false, error: "Invalid client secret provided." });
  });
});
