import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanCrawlerTool } from "../../../src/tools/builtin/security/crawler.js";
import { securityScanBflaTool } from "../../../src/tools/builtin/security/bfla.js";
import { securityScanCsrfTool } from "../../../src/tools/builtin/security/csrf.js";
import { clearSiteMapCacheForTests } from "../../../src/tools/builtin/security/site-map-cache.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

// Verifies the actual point of the shared cache: running
// security_scan_crawler once lets a LATER, separate call to
// security_scan_bfla/security_scan_csrf against the same site pick up its
// results automatically, with no observedEndpoints/fieldNames passed in —
// this is the "crawler auto-feeds the other tools" behavior cyberlens's
// own ScanContext provided, now backed by site-map-cache.ts.
describe("security_scan_crawler feeds bfla/csrf automatically via the shared session cache", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    clearSiteMapCacheForTests();
    server = http.createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>
          <a href="/contact">Contact</a>
          <script>fetch('/api/internal/admin-panel');</script>
          <form method="post" action="/contact/update">
            <input name="name" type="text" />
            <input name="email" type="email" />
          </form>
        </body></html>`);
        return;
      }
      if (req.url === "/contact") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>contact page</body></html>`);
        return;
      }
      if (req.url === "/api/internal/admin-panel") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"ok":true}`);
        return;
      }
      if (req.url === "/contact/update") {
        // any POST here would be a real submission — active csrf test isn't exercised in this test, no headers passed.
        res.writeHead(200).end("ok");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>generic app shell</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const crawlResult = await securityScanCrawlerTool.handler({ url: `${baseUrl}/` }, ctx);
    expect(crawlResult.isError).toBe(false);
  }, 30_000);

  afterAll(() => {
    server.close();
    clearSiteMapCacheForTests();
  });

  it("bfla picks up the crawler's observed admin-keyword endpoint with no observedEndpoints passed", async () => {
    const result = await securityScanBflaTool.handler({ url: baseUrl }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Broken Function Level Authorization (BFLA)");
    expect(result.content).toContain("/api/internal/admin-panel");
  }, 20_000);

  it("csrf picks up the crawler's discovered form fields with no fieldNames passed", async () => {
    const result = await securityScanCsrfTool.handler({ pageUrl: `${baseUrl}/`, formAction: `${baseUrl}/contact/update` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Form Missing CSRF Token");
    expect(result.content).toContain("name");
    expect(result.content).toContain("email");
  });

  it("csrf reports 'No fields given' for a page/action combination the crawler never saw", async () => {
    const result = await securityScanCsrfTool.handler({ pageUrl: `${baseUrl}/never-crawled`, formAction: `${baseUrl}/never-crawled/submit` }, ctx);
    expect(result.content).toContain("No fields given");
  });
});
