import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanXssTool, mergeEngineFindings } from "../../../src/tools/builtin/security/xss.js";
import type { Finding } from "../../../src/tools/builtin/security/types.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_xss tool (real Chromium, real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const name = url.searchParams.get("name") ?? "";
      if (url.pathname === "/vulnerable") {
        // Reflects the parameter directly into the HTML with no encoding — really exploitable.
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>Hello, ${name}!</body></html>`);
        return;
      }
      if (url.pathname === "/safe") {
        // HTML-encodes the reflection — not exploitable, even though the value is still visible.
        const escaped = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>Hello, ${escaped}!</body></html>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>no params reflected here</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("confirms reflected XSS by real script execution (not just string reflection)", async () => {
    const result = await securityScanXssTool.handler({ url: `${baseUrl}/vulnerable?name=test` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Reflected XSS in Parameter 'name'");
  }, 30_000);

  it("does not flag a properly HTML-encoded reflection, even though the value is visible", async () => {
    const result = await securityScanXssTool.handler({ url: `${baseUrl}/safe?name=test` }, ctx);
    expect(result.content).toContain("No reflected XSS confirmed");
  }, 30_000);

  it("reports no candidates for a URL with no query parameters", async () => {
    const result = await securityScanXssTool.handler({ url: `${baseUrl}/vulnerable` }, ctx);
    expect(result.content).toContain("No injectable GET parameters found");
  });
});

describe("mergeEngineFindings (pure cross-engine merge logic)", () => {
  function fakeFinding(id: string): Finding {
    return { id, title: `Reflected XSS in Parameter 'name'`, severity: "HIGH", description: "desc" };
  }

  it("merges a finding confirmed on every tested engine without flagging it inconsistent", () => {
    const perEngine = new Map([
      ["chromium", [fakeFinding("xss-reflected-abc")]],
      ["firefox", [fakeFinding("xss-reflected-abc")]],
    ]);
    const merged = mergeEngineFindings(perEngine);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe("Reflected XSS in Parameter 'name'");
    expect(merged[0]!.title).not.toContain("Inconsistent");
  });

  it("flags a finding confirmed on only some engines as Browser-Inconsistent, naming which", () => {
    const perEngine = new Map([
      ["chromium", [fakeFinding("xss-reflected-abc")]],
      ["firefox", [] as Finding[]],
    ]);
    const merged = mergeEngineFindings(perEngine);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toContain("Browser-Inconsistent");
    expect(merged[0]!.description).toContain("Confirmed on: chromium");
    expect(merged[0]!.description).toContain("NOT reproduced on: firefox");
  });

  it("produces no findings when no engine found anything", () => {
    const perEngine = new Map([
      ["chromium", [] as Finding[]],
      ["firefox", [] as Finding[]],
    ]);
    expect(mergeEngineFindings(perEngine)).toHaveLength(0);
  });
});
