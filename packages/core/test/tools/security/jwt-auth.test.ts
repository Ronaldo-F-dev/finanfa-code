import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { securityScanJwtAuthTool } from "../../../src/tools/builtin/security/jwt-auth.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(header: object, payload: object, secret: string | null): string {
  const h = base64Url(JSON.stringify(header));
  const p = base64Url(JSON.stringify(payload));
  if (secret === null) return `${h}.${p}.`;
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${base64Url(sig)}`;
}

describe("security_scan_jwt_auth tool (real local HTTP server, real HMAC verification)", () => {
  let server: http.Server;
  let baseUrl: string;
  let currentCookie = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": `session=${currentCookie}` });
        res.end("<html><body>home</body></html>");
        return;
      }
      if (req.url === "/api/v1/auth/login" && req.method === "POST") {
        // No rate limiting at all — every request gets a plain 401.
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid credentials" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("has 'ask' risk level", () => {
    expect(securityScanJwtAuthTool.riskLevel).toBe("ask");
  });

  it("cracks a real JWT signed with a common weak secret ('secret')", async () => {
    currentCookie = makeJwt({ alg: "HS256", typ: "JWT" }, { sub: "1234567890", name: "test" }, "secret");
    const result = await securityScanJwtAuthTool.handler({ url: baseUrl }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("JWT Signed With a Weak/Guessable Secret");
    expect(result.content).toContain('"secret"');
  });

  it("passes a real JWT signed with a strong random secret (resists the weak-secret wordlist)", async () => {
    currentCookie = makeJwt({ alg: "HS256", typ: "JWT" }, { sub: "1234567890" }, randomBytes(32).toString("hex"));
    const result = await securityScanJwtAuthTool.handler({ url: baseUrl }, ctx);
    expect(result.content).not.toContain("JWT Signed With a Weak/Guessable Secret");
    expect(result.content).toContain("alg:none is rejected");
  });

  it("flags alg:none as unsigned/forgeable", async () => {
    currentCookie = makeJwt({ alg: "none", typ: "JWT" }, { sub: "1234567890" }, null);
    const result = await securityScanJwtAuthTool.handler({ url: baseUrl }, ctx);
    expect(result.content).toContain("JWT 'alg: none' Not Rejected");
  });

  it("flags the login endpoint as having no rate limiting (never returns 429 for a real burst)", async () => {
    currentCookie = "";
    const result = await securityScanJwtAuthTool.handler({ url: baseUrl }, ctx);
    expect(result.content).toContain("No Rate Limiting on Authentication Endpoint");
  }, 15_000);
});
