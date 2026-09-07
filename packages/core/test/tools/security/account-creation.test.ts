import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanAccountCreationTool } from "../../../src/tools/builtin/security/account-creation.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_account_creation tool (real Chromium, real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;
  const createdAccounts: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/signup") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>
          <form id="reg" method="post" action="/signup">
            <input name="email" type="email" />
            <input name="password" type="password" />
            <input name="username" type="text" />
            <button type="submit">Create account</button>
          </form>
        </body></html>`);
        return;
      }
      if (req.method === "POST" && req.url === "/signup") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          createdAccounts.push(body);
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<html><body><h1>Welcome!</h1><p>Account created successfully.</p></body></html>");
        });
        return;
      }
      if (req.method === "GET" && req.url === "/signup-captcha") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>
          <form method="post" action="/signup-captcha">
            <input name="email" type="email" />
            <input name="password" type="password" />
            <div class="g-recaptcha" data-sitekey="test"></div>
            <button type="submit">Sign up</button>
          </form>
        </body></html>`);
        return;
      }
      if (req.method === "GET" && req.url === "/signup-rejected") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>
          <form method="post" action="/signup-rejected">
            <input name="email" type="email" />
            <input name="password" type="password" />
            <button type="submit">Register</button>
          </form>
        </body></html>`);
        return;
      }
      if (req.method === "POST" && req.url === "/signup-rejected") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>Error: invalid email address</body></html>");
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

  it("fills and submits a registration form with no CAPTCHA, detects apparent success", async () => {
    const result = await securityScanAccountCreationTool.handler({ url: `${baseUrl}/signup` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Account Creation Succeeded Without CAPTCHA/Bot Protection");
    expect(createdAccounts.length).toBe(1);
    expect(createdAccounts[0]).toContain("%40example.com");
  }, 30_000);

  it("stops and reports a passed control when a CAPTCHA is present", async () => {
    const result = await securityScanAccountCreationTool.handler({ url: `${baseUrl}/signup-captcha` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("CAPTCHA protection present");
    expect(result.content).not.toContain("Account Creation Succeeded");
  }, 30_000);

  it("reports no apparent success when the server rejects the submission", async () => {
    const result = await securityScanAccountCreationTool.handler({ url: `${baseUrl}/signup-rejected` }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Account Creation Succeeded");
    expect(result.content).toContain("did not appear to succeed");
  }, 30_000);

  it("rejects an invalid URL", async () => {
    const result = await securityScanAccountCreationTool.handler({ url: "not-a-url" }, ctx);
    expect(result.isError).toBe(true);
  });
});
