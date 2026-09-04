import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanHostHeaderInjectionTool } from "../../../src/tools/builtin/security/host-header-injection.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_host_header_injection tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/vulnerable") {
        // Builds a "canonical link" straight from the incoming Host header — vulnerable.
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>Reset your password: https://${req.headers.host}/reset</body></html>`);
        return;
      }
      if (req.url === "/vulnerable-redirect") {
        res.writeHead(302, { Location: `https://${req.headers.host}/canonical` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>a normal page, ignores Host</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("confirms host header injection when the canary is reflected in the response body", async () => {
    const result = await securityScanHostHeaderInjectionTool.handler({ url: `${baseUrl}/vulnerable` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Host Header Injection");
    expect(result.content).toContain("response body");
  });

  it("confirms host header injection when the canary is reflected in a redirect Location header", async () => {
    const result = await securityScanHostHeaderInjectionTool.handler({ url: `${baseUrl}/vulnerable-redirect` }, ctx);
    expect(result.content).toContain("Host Header Injection");
    expect(result.content).toContain("Location header");
  });

  it("passes when the Host header isn't reflected anywhere", async () => {
    const result = await securityScanHostHeaderInjectionTool.handler({ url: `${baseUrl}/normal` }, ctx);
    expect(result.content).toContain("Host header not trusted");
  });
});
