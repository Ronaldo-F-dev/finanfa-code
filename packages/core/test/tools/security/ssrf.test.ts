import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanSsrfTool } from "../../../src/tools/builtin/security/ssrf.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_ssrf tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const target = url.searchParams.get("fetch_url");
      if (url.pathname === "/vulnerable" && target === "http://169.254.169.254/latest/meta-data/") {
        // Simulates a server that actually fetched the SSRF payload and returned real metadata content.
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ami-id: ami-0abcdef1234567890\ninstance-id: i-0123456789abcdef0");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("some other content, no metadata leaked");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("confirms SSRF when the response discloses real cloud metadata content", async () => {
    const result = await securityScanSsrfTool.handler({ url: `${baseUrl}/vulnerable?fetch_url=https://example.com` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Server-Side Request Forgery (SSRF) via 'fetch_url'");
  });

  it("does not flag a parameter whose response never discloses metadata", async () => {
    const result = await securityScanSsrfTool.handler({ url: `${baseUrl}/safe?fetch_url=https://example.com` }, ctx);
    expect(result.content).toContain("No server-side request forgery detected");
  });

  it("reports no candidates for a URL with no URL-like parameters", async () => {
    const result = await securityScanSsrfTool.handler({ url: `${baseUrl}/vulnerable?name=bob` }, ctx);
    expect(result.content).toContain("No URL-accepting parameters found");
  });
});
