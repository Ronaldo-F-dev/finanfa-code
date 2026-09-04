import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanXxeTool } from "../../../src/tools/builtin/security/xxe.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_xxe tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/vulnerable" && body.includes("<!ENTITY xxe")) {
          // Simulates a naive XML parser that really resolved the external entity.
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1::/usr/sbin:/usr/sbin/nologin");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ignored, not an XML endpoint");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("has 'dangerous' risk level (sends a real unsolicited POST payload)", () => {
    expect(securityScanXxeTool.riskLevel).toBe("dangerous");
  });

  it("confirms XXE when the response reflects /etc/passwd content", async () => {
    const result = await securityScanXxeTool.handler({ endpoint: `${baseUrl}/vulnerable` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("XML External Entity (XXE) Injection");
  });

  it("does not flag an endpoint that ignores the XML payload", async () => {
    const result = await securityScanXxeTool.handler({ endpoint: `${baseUrl}/safe` }, ctx);
    expect(result.content).toContain("No XXE detected");
  });

  it("reports a clear error for an unreachable endpoint", async () => {
    const result = await securityScanXxeTool.handler({ endpoint: "http://127.0.0.1:1" }, ctx);
    expect(result.isError).toBe(true);
  });
});
