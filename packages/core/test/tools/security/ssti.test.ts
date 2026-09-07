import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanSstiTool } from "../../../src/tools/builtin/security/ssti.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_ssti tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const name = url.searchParams.get("name") ?? "";
      if (url.pathname === "/vulnerable" && name.includes("{{7*77}}")) {
        // Simulates a naive template engine that actually evaluates the expression.
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>Hello, 539!</body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>Hello, ${name}!</body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("has 'dangerous' risk level", () => {
    expect(securityScanSstiTool.riskLevel).toBe("dangerous");
  });

  it("confirms SSTI when 7*77 is actually evaluated into 539", async () => {
    const result = await securityScanSstiTool.handler({ url: `${baseUrl}/vulnerable?name=test` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Server-Side Template Injection in 'name'");
  });

  it("does not flag a handler that just reflects the payload literally (no evaluation)", async () => {
    const result = await securityScanSstiTool.handler({ url: `${baseUrl}/safe?name=test` }, ctx);
    expect(result.content).toContain("No SSTI detected");
  });
});
