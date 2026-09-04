import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanWafTool } from "../../../src/tools/builtin/security/waf.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_waf tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/cloudflare") {
        res.writeHead(200, { "cf-ray": "abc123" });
        res.end("ok");
        return;
      }
      if (url.pathname === "/behavioral-block") {
        if (url.searchParams.has("finanfa_waf_probe")) {
          res.writeHead(403);
          res.end("blocked");
        } else {
          res.writeHead(200);
          res.end("ok");
        }
        return;
      }
      res.writeHead(200);
      res.end("plain server, nothing special");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("detects Cloudflare via the cf-ray header signature", async () => {
    const result = await securityScanWafTool.handler({ url: `${baseUrl}/cloudflare` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Web Application Firewall Detected: Cloudflare");
  });

  it("detects a behavioral block (probe request rejected, baseline accepted) with no header signature", async () => {
    const result = await securityScanWafTool.handler({ url: `${baseUrl}/behavioral-block` }, ctx);
    expect(result.content).toContain("Web Application Firewall Detected");
    expect(result.content).toContain("active request blocking");
  });

  it("reports 'no WAF detected' as a passed control for a plain, unprotected server", async () => {
    const result = await securityScanWafTool.handler({ url: `${baseUrl}/plain` }, ctx);
    expect(result.content).toContain("No WAF detected");
    expect(result.content).not.toContain("Web Application Firewall Detected");
  });
});
