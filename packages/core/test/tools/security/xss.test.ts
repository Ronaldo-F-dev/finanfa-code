import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanXssTool } from "../../../src/tools/builtin/security/xss.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_xss tool (real Chromium, real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const name = url.searchParams.get("name") ?? "";
      if (url.pathname === "/vulnerable") {
        // Reflects the parameter directly into the HTML with no encoding — really exploitable.
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>Hello, ${name}!</body></html>`);
        return;
      }
      if (url.pathname === "/safe") {
        // HTML-encodes the reflection — not exploitable, even though the value is still visible.
        const escaped = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>Hello, ${escaped}!</body></html>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>no params reflected here</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("confirms reflected XSS by real script execution (not just string reflection)", async () => {
    const result = await securityScanXssTool.handler({ url: `${baseUrl}/vulnerable?name=test` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Reflected XSS in Parameter 'name'");
  }, 30_000);

  it("does not flag a properly HTML-encoded reflection, even though the value is visible", async () => {
    const result = await securityScanXssTool.handler({ url: `${baseUrl}/safe?name=test` }, ctx);
    expect(result.content).toContain("No reflected XSS confirmed");
  }, 30_000);

  it("reports no candidates for a URL with no query parameters", async () => {
    const result = await securityScanXssTool.handler({ url: `${baseUrl}/vulnerable` }, ctx);
    expect(result.content).toContain("No injectable GET parameters found");
  });
});
