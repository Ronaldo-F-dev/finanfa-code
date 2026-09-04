import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanLfiTool } from "../../../src/tools/builtin/security/lfi.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_lfi tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const file = url.searchParams.get("file");
      if (url.pathname === "/vulnerable" && file?.includes("etc/passwd")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("root:x:0:0:root:/root:/bin/bash");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("normal file content, no traversal");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("confirms LFI when the response discloses /etc/passwd content", async () => {
    const result = await securityScanLfiTool.handler({ url: `${baseUrl}/vulnerable?file=report.pdf` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Local File Inclusion / Path Traversal in 'file'");
  });

  it("does not flag a parameter that isn't actually vulnerable", async () => {
    const result = await securityScanLfiTool.handler({ url: `${baseUrl}/safe?file=report.pdf` }, ctx);
    expect(result.content).toContain("No local file inclusion detected");
  });

  it("reports no candidates for a URL with no query parameters", async () => {
    const result = await securityScanLfiTool.handler({ url: `${baseUrl}/vulnerable` }, ctx);
    expect(result.content).toContain("No injectable parameters found");
  });
});
