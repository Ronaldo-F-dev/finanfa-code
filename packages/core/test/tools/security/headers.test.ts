import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanHeadersTool } from "../../../src/tools/builtin/security/headers.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_headers tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/bare") {
        // No security headers at all — every "missing" check should fire.
        res.writeHead(200, { "content-type": "text/html" });
        res.end("hello");
        return;
      }
      if (req.url === "/hardened") {
        res.writeHead(200, {
          "content-type": "text/html",
          "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
          "permissions-policy": "geolocation=()",
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
          "cross-origin-resource-policy": "same-origin",
          "strict-transport-security": "max-age=63072000",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "set-cookie": "session=abc; HttpOnly; Secure; SameSite=Strict",
        });
        res.end("hardened");
        return;
      }
      if (req.url === "/insecure-cookie") {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "session=abc" });
        res.end("insecure cookie");
        return;
      }
      if (req.url === "/powered-by") {
        res.writeHead(200, { "content-type": "text/html", "x-powered-by": "Express" });
        res.end("powered by");
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("has 'ask' risk level (it's a security tool that hits an external-ish target)", () => {
    expect(securityScanHeadersTool.riskLevel).toBe("ask");
  });

  it("reports every missing security header for a bare response", async () => {
    const result = await securityScanHeadersTool.handler({ url: `${baseUrl}/bare` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Missing content-security-policy Header");
    expect(result.content).toContain("Missing permissions-policy Header");
    expect(result.content).toContain("Missing X-Content-Type-Options Header");
    expect(result.content).toContain("Missing Clickjacking Protection");
    expect(result.content).toContain("CVSS");
  });

  it("reports passed controls and no related findings for a fully hardened response", async () => {
    const result = await securityScanHeadersTool.handler({ url: `${baseUrl}/hardened` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Missing content-security-policy Header");
    expect(result.content).not.toContain("Missing Clickjacking Protection");
    expect(result.content).not.toContain("Missing X-Content-Type-Options Header");
    expect(result.content).toContain("Passed controls");
    expect(result.content).toContain("HSTS");
  });

  it("flags a cookie missing HttpOnly/Secure flags", async () => {
    const result = await securityScanHeadersTool.handler({ url: `${baseUrl}/insecure-cookie` }, ctx);
    expect(result.content).toContain("Cookies Missing Security Flags");
    expect(result.content).toContain("missing HttpOnly, Secure");
  });

  it("flags X-Powered-By as a tech-disclosure finding", async () => {
    const result = await securityScanHeadersTool.handler({ url: `${baseUrl}/powered-by` }, ctx);
    expect(result.content).toContain("Technology Stack Disclosed via X-Powered-By");
    expect(result.content).toContain("Express");
  });

  it("reports a clear error for an unreachable target instead of throwing", async () => {
    const result = await securityScanHeadersTool.handler({ url: "http://127.0.0.1:1" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("could not reach");
  });
});
