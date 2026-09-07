import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanSecretsTool } from "../../../src/tools/builtin/security/secrets.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_secrets tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/v1/admin/dashboard") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Cannot POST /api/v1/admin/dashboard");
        return;
      }
      if (req.url === "/leaky") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>Config: AKIAIOSFODNN7EXAMPLE is our AWS key</body></html>");
        return;
      }
      if (req.url === "/stack-trace") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Traceback (most recent call last):\n  File \"app.py\", line 1\nValueError");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>clean page</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("detects a real AWS access key pattern in the response body", async () => {
    const result = await securityScanSecretsTool.handler({ url: `${baseUrl}/leaky` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("AWS access key Exposed in Response");
  });

  it("detects a leaked stack trace", async () => {
    const result = await securityScanSecretsTool.handler({ url: `${baseUrl}/stack-trace` }, ctx);
    expect(result.content).toContain("Stack Trace Disclosed in Response");
  });

  it("detects an internal route echoed back in an unsupported-method error", async () => {
    const result = await securityScanSecretsTool.handler({ url: baseUrl }, ctx);
    expect(result.content).toContain("Internal Route Disclosed via Error Message");
  });

  it("passes cleanly for a page with none of the above", async () => {
    const result = await securityScanSecretsTool.handler({ url: `${baseUrl}/clean-no-route-leak-check` }, ctx);
    // Route-leak check always probes the same fixed path regardless of
    // the target URL, so it still fires here too — only assert no secret/stack-trace finding leaked.
    expect(result.content).not.toContain("Exposed in Response");
    expect(result.content).not.toContain("Stack Trace Disclosed");
  });
});
