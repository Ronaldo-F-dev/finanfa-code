import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanCrawlerTool } from "../../../src/tools/builtin/security/crawler.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_crawler tool (real Chromium, real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>
          <a href="/about">About</a>
          <a href="/contact">Contact</a>
          <a href="https://external.example.com/other">External</a>
        </body></html>`);
        return;
      }
      if (req.url === "/about") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>About page. <a href="/">Home</a></body></html>`);
        return;
      }
      if (req.url === "/contact") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>
          <form method="post" action="/contact">
            <input name="name" type="text" />
            <input name="email" type="email" />
            <input name="message" type="text" />
            <button type="submit">Send</button>
          </form>
        </body></html>`);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("crawls same-origin pages, discovers forms, and stays off external links", async () => {
    const result = await securityScanCrawlerTool.handler({ url: `${baseUrl}/` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Site Map Discovered");
    expect(result.content).toContain(`${baseUrl}/about`);
    expect(result.content).toContain(`${baseUrl}/contact`);
    expect(result.content).not.toContain("external.example.com");
    expect(result.content).toContain("POST");
    expect(result.content).toContain("fields: name, email, message");
  }, 30_000);

  it("rejects an invalid URL", async () => {
    const result = await securityScanCrawlerTool.handler({ url: "not-a-url" }, ctx);
    expect(result.isError).toBe(true);
  });
});
