import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanSriTool } from "../../../src/tools/builtin/security/sri.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_sri tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      if (req.url === "/missing-sri") {
        res.end(
          `<html><head>
            <script src="https://cdn.example.com/lib.js"></script>
            <link rel="stylesheet" href="https://cdn.example.com/style.css">
          </head><body>hi</body></html>`,
        );
      } else if (req.url === "/with-sri") {
        res.end(
          `<html><head>
            <script src="https://cdn.example.com/lib.js" integrity="sha384-abc" crossorigin="anonymous"></script>
          </head><body>hi</body></html>`,
        );
      } else if (req.url === "/local-only") {
        res.end(`<html><head><script src="/local.js"></script></head><body>hi</body></html>`);
      } else {
        res.end("<html><body>plain</body></html>");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("flags an external script/stylesheet with no integrity attribute", async () => {
    const result = await securityScanSriTool.handler({ url: `${baseUrl}/missing-sri` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Missing Subresource Integrity");
    expect(result.content).toContain("2 externally-hosted");
  });

  it("passes when every external resource has an integrity attribute", async () => {
    const result = await securityScanSriTool.handler({ url: `${baseUrl}/with-sri` }, ctx);
    expect(result.content).not.toContain("Missing Subresource Integrity");
    expect(result.content).toContain("use an `integrity` attribute");
  });

  it("passes with 'nothing requiring SRI' when every resource is same-origin", async () => {
    const result = await securityScanSriTool.handler({ url: `${baseUrl}/local-only` }, ctx);
    expect(result.content).toContain("No externally-hosted");
  });
});
