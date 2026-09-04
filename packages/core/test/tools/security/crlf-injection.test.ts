import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanCrlfInjectionTool } from "../../../src/tools/builtin/security/crlf-injection.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_crlf_injection tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // A deliberately vulnerable handler: writes the raw response directly
    // to the socket (bypassing Node's own http API, which sanitizes header
    // values against CRLF) so a decoded CRLF in the "redirect" parameter
    // really does splice an extra header into the raw response — the same
    // real-world bug class this tool detects, not a mock of it.
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/vulnerable") {
        const redirect = url.searchParams.get("redirect") ?? "";
        req.socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-Echo: ${redirect}\r\nContent-Length: 2\r\n\r\nok`);
        req.socket.end();
        return;
      }
      if (url.pathname === "/safe") {
        // Uses the normal http API, which sanitizes the header value — not vulnerable.
        res.setHeader("X-Echo", (url.searchParams.get("redirect") ?? "").replace(/[\r\n]/g, ""));
        res.writeHead(200);
        res.end("ok");
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("confirms real CRLF injection when the marker header actually splices into the raw response", async () => {
    const result = await securityScanCrlfInjectionTool.handler({ url: `${baseUrl}/vulnerable?redirect=/home` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("CRLF Injection via 'redirect'");
  });

  it("does not flag a parameter whose value is safely handled", async () => {
    const result = await securityScanCrlfInjectionTool.handler({ url: `${baseUrl}/safe?redirect=/home` }, ctx);
    expect(result.content).toContain("No CRLF injection detected");
  });

  it("reports no candidates for a URL with no query parameters", async () => {
    const result = await securityScanCrlfInjectionTool.handler({ url: `${baseUrl}/vulnerable` }, ctx);
    expect(result.content).toContain("No injectable parameters found");
  });
});
