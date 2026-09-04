import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanCachePoisoningTool } from "../../../src/tools/builtin/security/cache-poisoning.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_cache_poisoning tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const fwdHost = req.headers["x-forwarded-host"];
      if (req.url === "/vulnerable") {
        res.writeHead(200, { "content-type": "text/html", "cache-control": "public, max-age=3600" });
        res.end(`<html><body>canonical link: https://${fwdHost}/page</body></html>`);
        return;
      }
      if (req.url === "/reflected-not-cacheable") {
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
        res.end(`<html><body>https://${fwdHost}/page</body></html>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "public, max-age=3600" });
      res.end("<html><body>ignores X-Forwarded-Host entirely</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("flags both preconditions met (reflected + cacheable) as a heuristic MEDIUM finding", async () => {
    const result = await securityScanCachePoisoningTool.handler({ url: `${baseUrl}/vulnerable` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Potential Web Cache Poisoning");
    expect(result.content).toContain("[MEDIUM]");
  });

  it("passes (with an explanatory note) when reflected but not cacheable", async () => {
    const result = await securityScanCachePoisoningTool.handler({ url: `${baseUrl}/reflected-not-cacheable` }, ctx);
    expect(result.content).not.toContain("Potential Web Cache Poisoning");
    expect(result.content).toContain("non-cacheable response");
  });

  it("passes when the header isn't reflected at all", async () => {
    const result = await securityScanCachePoisoningTool.handler({ url: `${baseUrl}/safe` }, ctx);
    expect(result.content).toContain("X-Forwarded-Host not reflected");
  });
});
