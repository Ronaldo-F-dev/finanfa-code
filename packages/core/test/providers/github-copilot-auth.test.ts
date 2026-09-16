import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { requestDeviceCode, checkDeviceAuthorization, pollForAccessToken } from "../../src/providers/github-copilot-auth.js";

describe("GitHub Copilot device-authorization flow (real local HTTP server standing in for github.com)", () => {
  let server: http.Server;
  let baseUrl: string;
  let tokenResponses: RawResponse[];
  let requestedBodies: Record<string, unknown>[];

  type RawResponse = { access_token?: string; error?: string };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        requestedBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url === "/login/device/code") {
          res.end(JSON.stringify({ device_code: "devcode123", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 }));
          return;
        }
        // /login/oauth/access_token — pop the next scripted response
        res.end(JSON.stringify(tokenResponses.shift() ?? { error: "authorization_pending" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("requests a device code with the given client_id", async () => {
    requestedBodies = [];
    tokenResponses = [];
    const result = await requestDeviceCode("test-client-id", baseUrl);
    expect(result).toEqual({ deviceCode: "devcode123", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", intervalSeconds: 5, expiresInSeconds: 900 });
    expect(requestedBodies[0]).toMatchObject({ client_id: "test-client-id" });
  });

  it("checkDeviceAuthorization reports pending/authorized/denied/expired/slow_down from the real response shape", async () => {
    tokenResponses = [{ error: "authorization_pending" }];
    expect(await checkDeviceAuthorization("dc", "c", baseUrl)).toEqual({ status: "pending" });

    tokenResponses = [{ error: "slow_down" }];
    expect(await checkDeviceAuthorization("dc", "c", baseUrl)).toEqual({ status: "slow_down" });

    tokenResponses = [{ error: "expired_token" }];
    expect(await checkDeviceAuthorization("dc", "c", baseUrl)).toEqual({ status: "expired" });

    tokenResponses = [{ error: "access_denied" }];
    expect(await checkDeviceAuthorization("dc", "c", baseUrl)).toEqual({ status: "denied" });

    tokenResponses = [{ access_token: "gho_realtoken" }];
    expect(await checkDeviceAuthorization("dc", "c", baseUrl)).toEqual({ status: "authorized", accessToken: "gho_realtoken" });
  });

  it("pollForAccessToken waits through pending attempts and resolves once authorized, with an injectable sleep (no real wall-clock wait in this test)", async () => {
    tokenResponses = [{ error: "authorization_pending" }, { error: "authorization_pending" }, { access_token: "gho_final" }];
    const sleeps: number[] = [];
    const token = await pollForAccessToken("dc", 5, "c", baseUrl, async (ms) => {
      sleeps.push(ms);
    });
    expect(token).toBe("gho_final");
    expect(sleeps).toEqual([5000, 5000, 5000]);
  });

  it("pollForAccessToken throws a clear error when the user denies it", async () => {
    tokenResponses = [{ error: "access_denied" }];
    await expect(pollForAccessToken("dc", 5, "c", baseUrl, async () => {})).rejects.toThrow(/denied/);
  });
});
