import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanOpenRedirectTool } from "../../../src/tools/builtin/security/open-redirect.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_open_redirect tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const next = url.searchParams.get("next");
      if (url.pathname === "/vulnerable") {
        // Naively redirects to whatever "next" says, no validation.
        res.writeHead(302, { Location: next ?? "/" });
        res.end();
        return;
      }
      if (url.pathname === "/safe") {
        // Always redirects home regardless of "next" — not vulnerable.
        res.writeHead(302, { Location: "/home" });
        res.end();
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

  it("confirms a real open redirect when the server forwards to the injected canary host", async () => {
    const result = await securityScanOpenRedirectTool.handler({ url: `${baseUrl}/vulnerable?next=/somewhere` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Open Redirect via 'next'");
    expect(result.content).toContain("canary");
  });

  it("does not flag a redirect that ignores the parameter and always goes somewhere fixed", async () => {
    const result = await securityScanOpenRedirectTool.handler({ url: `${baseUrl}/safe?next=/somewhere` }, ctx);
    expect(result.content).toContain("No open redirect detected");
  });

  it("reports no candidates when the URL has no redirect-like query parameters", async () => {
    const result = await securityScanOpenRedirectTool.handler({ url: `${baseUrl}/vulnerable` }, ctx);
    expect(result.content).toContain("No redirect-driving parameters found");
  });

  it("rejects a malformed URL", async () => {
    const result = await securityScanOpenRedirectTool.handler({ url: "not a url" }, ctx);
    expect(result.isError).toBe(true);
  });
});
