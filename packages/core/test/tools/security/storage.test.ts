import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanStorageTool } from "../../../src/tools/builtin/security/storage.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_storage tool (real Chromium, real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/vulnerable") {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "session_id=abc123; Path=/" });
        res.end(
          `<html><body>
            <script>
              localStorage.setItem("auth_token", "sk_live_ABCDEF1234567890");
              document.title = "ready";
            </script>
          </body></html>`,
        );
        return;
      }
      if (req.url === "/clean") {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "session_id=abc123; Path=/; HttpOnly" });
        res.end(`<html><body><script>localStorage.setItem("theme", "dark");</script></body></html>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>plain</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("confirms a real secret-shaped value stored in localStorage and a JS-readable session cookie", async () => {
    const result = await securityScanStorageTool.handler({ url: `${baseUrl}/vulnerable` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Sensitive Data Stored in Browser localStorage");
    expect(result.content).toContain("Session/Auth Cookie Readable via JavaScript");
  }, 30_000);

  it("does not flag localStorage/cookies that don't look sensitive or are properly HttpOnly", async () => {
    const result = await securityScanStorageTool.handler({ url: `${baseUrl}/clean` }, ctx);
    expect(result.content).not.toContain("Sensitive Data Stored");
    expect(result.content).not.toContain("Readable via JavaScript");
  }, 30_000);
});
