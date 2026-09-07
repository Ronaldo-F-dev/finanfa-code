import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanSqliTool } from "../../../src/tools/builtin/security/sqli.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_sqli tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const id = url.searchParams.get("id") ?? "";
      if (url.pathname === "/error-based") {
        // Simulates a naive handler that concatenates the value into a
        // "query" and echoes a MySQL-style error when it contains a stray quote.
        if (id.includes("'")) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("row found");
        return;
      }
      if (url.pathname === "/boolean-blind") {
        // Simulates a blind injectable endpoint: an always-true condition
        // returns the same as a normal id, an always-false one returns an
        // empty-results page — classic boolean-blind signal.
        if (id.includes("'1'='1'")) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("row data: " + "x".repeat(200));
        } else if (id.includes("'1'='2'")) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("no results");
        } else {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("row data: " + "x".repeat(200));
        }
        return;
      }
      // Safe handler: parameterized internally, ignores SQL-looking payloads entirely.
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("row data: " + "x".repeat(200));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("has 'dangerous' risk level (sends real injection payloads)", () => {
    expect(securityScanSqliTool.riskLevel).toBe("dangerous");
  });

  it("confirms error-based SQLi via a real matched database error signature", async () => {
    const result = await securityScanSqliTool.handler({ url: `${baseUrl}/error-based?id=1` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("SQL Injection (Error-Based) in 'id'");
  });

  it("flags boolean-blind SQLi when true/false conditions produce different responses", async () => {
    const result = await securityScanSqliTool.handler({ url: `${baseUrl}/boolean-blind?id=1` }, ctx);
    expect(result.content).toContain("Possible Blind SQL Injection in 'id'");
  });

  it("does not flag a parameterized (safe) handler", async () => {
    const result = await securityScanSqliTool.handler({ url: `${baseUrl}/safe?id=1` }, ctx);
    expect(result.content).toContain("No SQL injection detected");
  });

  it("reports no candidates for a URL with no query parameters", async () => {
    const result = await securityScanSqliTool.handler({ url: `${baseUrl}/safe` }, ctx);
    expect(result.content).toContain("No injectable parameters found");
  });
});
