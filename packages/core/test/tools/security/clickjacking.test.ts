import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanClickjackingTool } from "../../../src/tools/builtin/security/clickjacking.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_clickjacking tool (real Chromium, real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/protected") {
        res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY" });
        res.end("<html><body>protected content</body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>unprotected content</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("confirms real embedding (with a screenshot as evidence) for a page with no frame protection", async () => {
    const result = await securityScanClickjackingTool.handler({ url: `${baseUrl}/unprotected` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Clickjacking Confirmed");
    expect(result.images).toBeDefined();
    expect(result.images?.[0].mimeType).toBe("image/png");
    expect(result.images?.[0].base64.length).toBeGreaterThan(100);
  }, 30_000);

  it("reports the active test as a passed control when X-Frame-Options: DENY actually blocks the embed", async () => {
    const result = await securityScanClickjackingTool.handler({ url: `${baseUrl}/protected` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Clickjacking Confirmed");
    expect(result.content).toContain("Clickjacking (active test)");
    expect(result.images).toBeUndefined();
  }, 30_000);
});
