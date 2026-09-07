import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanDiscoveryTool } from "../../../src/tools/builtin/security/discovery.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_discovery tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === "TRACE") {
        res.writeHead(200, { "content-type": "message/http" });
        res.end(`TRACE ${req.url} HTTP/1.1\r\nHost: x`);
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(200, { allow: "GET, POST, PUT, DELETE" });
        res.end();
        return;
      }
      if (req.url === "/.env") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("DB_PASSWORD=supersecret\nAPI_KEY=abc123\nSECRET_TOKEN=xyz9876543210verylongvalue\n");
        return;
      }
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /internal-admin\nDisallow: /private-api\nDisallow: /\n");
        return;
      }
      if (req.url === "/openapi.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ openapi: "3.0.0", paths: { "/users": {}, "/orders": {} } }));
        return;
      }
      if (req.url === "/graphql" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { __schema: { types: [{ name: "Query" }, { name: "User" }] } } }));
        return;
      }
      // Soft-404: every unknown path (including the discovery baseline
      // probe and every sensitive path not explicitly handled above)
      // gets the same SPA shell.
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>app shell</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 20_000);

  afterAll(() => {
    server.close();
  });

  it(
    "confirms every real finding (.env, robots.txt, OpenAPI, GraphQL introspection, TRACE, dangerous methods) " +
      "and doesn't flag paths returning only the generic soft-404 shell",
    async () => {
      const result = await securityScanDiscoveryTool.handler({ url: baseUrl }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Environment File Exposed");
      expect(result.content).toContain("robots.txt Discloses Internal Paths");
      expect(result.content).toContain("Full API Schema Exposed via OpenAPI Specification");
      expect(result.content).toContain("GraphQL Introspection Enabled");
      expect(result.content).toContain("HTTP TRACE Method Enabled");
      expect(result.content).toContain("Dangerous HTTP Methods Advertised");
      // /admin, /.git/config etc. are never explicitly handled above, so
      // they fall through to the same soft-404 shell as the baseline —
      // must NOT be flagged as exposed.
      expect(result.content).not.toContain("Admin Interface Reachable");
      expect(result.content).not.toContain("Git Repository Metadata Exposed");
    },
    20_000,
  );

  it("rejects a malformed URL with a clear error", async () => {
    const result = await securityScanDiscoveryTool.handler({ url: "not a url" }, ctx);
    expect(result.isError).toBe(true);
  });
});
