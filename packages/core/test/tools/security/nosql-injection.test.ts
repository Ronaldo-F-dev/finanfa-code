import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanNosqlInjectionTool } from "../../../src/tools/builtin/security/nosql-injection.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_nosql_injection tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const id = url.searchParams.get("id") ?? "";
      if (url.pathname === "/error-based") {
        if (id.includes("||")) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("MongoServerError: unsupported operator in query");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("row found");
        return;
      }
      if (url.pathname === "/boolean-blind") {
        if (id.includes("'1'=='1")) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("row data: " + "x".repeat(200));
        } else if (id.includes("'1'=='2")) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("no results");
        } else {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("row data: " + "x".repeat(200));
        }
        return;
      }
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

  it("has 'dangerous' risk level", () => {
    expect(securityScanNosqlInjectionTool.riskLevel).toBe("dangerous");
  });

  it("confirms error-based NoSQLi via a real matched MongoDB error signature", async () => {
    const result = await securityScanNosqlInjectionTool.handler({ url: `${baseUrl}/error-based?id=1` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("NoSQL Injection (Error-Based) in 'id'");
  });

  it("flags boolean-blind NoSQLi when true/false conditions produce different responses", async () => {
    const result = await securityScanNosqlInjectionTool.handler({ url: `${baseUrl}/boolean-blind?id=1` }, ctx);
    expect(result.content).toContain("Possible Blind NoSQL Injection in 'id'");
  });

  it("does not flag a safe handler", async () => {
    const result = await securityScanNosqlInjectionTool.handler({ url: `${baseUrl}/safe?id=1` }, ctx);
    expect(result.content).toContain("No NoSQL injection detected");
  });
});
