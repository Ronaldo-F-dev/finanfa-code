import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanIdorTool } from "../../../src/tools/builtin/security/idor.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_idor tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // A tiny fake "orders" API: order 42 belongs to "session-a", but the
    // vulnerable path doesn't check ownership (returns any numeric order
    // ID's content regardless of session, and even with no session at all).
    server = http.createServer((req, res) => {
      const match = /^\/api\/orders\/(\d+)$/.exec(req.url ?? "");
      if (match && req.url?.startsWith("/api/orders/")) {
        if (req.url.includes("/api/orders/") && (req.headers["x-mode"] === "vulnerable" || true)) {
          const id = match[1];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ orderId: id, content: `order number ${id} full details`.padEnd(60, ".") }));
          return;
        }
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("reports testing not performed when no session headers are given", async () => {
    const result = await securityScanIdorTool.handler({ url: `${baseUrl}/api/orders/42` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("testing not performed");
  });

  it("confirms IDOR: neighboring order ID returns distinct valid content with the same session", async () => {
    const result = await securityScanIdorTool.handler({ url: `${baseUrl}/api/orders/42`, headers: { Cookie: "session=a" } }, ctx);
    expect(result.content).toContain("Possible Insecure Direct Object Reference");
  });

  it("confirms missing auth: identical content returned with no headers at all", async () => {
    const result = await securityScanIdorTool.handler({ url: `${baseUrl}/api/orders/42`, headers: { Cookie: "session=a" } }, ctx);
    expect(result.content).toContain("Authenticated Endpoint Reachable Without Authentication");
  });

  it("reports no numeric ID segment for a URL without one", async () => {
    const result = await securityScanIdorTool.handler({ url: `${baseUrl}/api/orders/abc`, headers: { Cookie: "session=a" } }, ctx);
    expect(result.content).toContain("No numeric resource-ID path segment found");
  });
});
