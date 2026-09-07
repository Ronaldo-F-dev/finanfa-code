import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanBflaTool } from "../../../src/tools/builtin/security/bfla.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_bfla tool (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/console") {
        // A real admin console, reachable with no auth check at all.
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body><h1>Admin Console</h1><table>...user management...</table></body></html>");
        return;
      }
      if (req.url === "/manage") {
        // Properly gated behind a login page.
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>Please log in to continue</body></html>");
        return;
      }
      if (req.url === "/actuator") {
        // Gated behind a login page for anonymous visitors, but functional
        // for a non-admin session (the authenticated-heuristic path).
        if (req.headers.cookie === "session=nonadmin") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<html><body><h1>Actuator</h1>real env/health data here, distinctly longer than the shell</body></html>");
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>Please log in to continue</body></html>");
        return;
      }
      if (req.url === "/api/internal/admin-reports") {
        // An admin-keyword-matching endpoint only reachable via observedEndpoints.
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body><h1>Internal Admin Reports</h1>real functional report data here</body></html>");
        return;
      }
      // Every other path (including the not-found probe and the rest of
      // the candidate list) gets the same generic 200 SPA shell — this is
      // the soft-404 case the baseline technique exists to avoid
      // misreading as "every admin path is reachable".
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>generic app shell</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("confirms BFLA for a real admin console reachable with no auth check", async () => {
    const result = await securityScanBflaTool.handler({ url: baseUrl }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Broken Function Level Authorization (BFLA)");
    expect(result.content).toContain("/console");
  }, 20_000);

  it("does not flag a properly login-gated admin path", async () => {
    const result = await securityScanBflaTool.handler({ url: baseUrl }, ctx);
    // /manage returns the login-gate marker, so it must not appear among the findings' evidence for that path.
    const consoleFindingOnly = result.content.split("Broken Function Level Authorization").length - 1;
    expect(consoleFindingOnly).toBe(1); // only /console, not /manage
  }, 20_000);

  it("does not flag paths that just return the generic soft-404 shell", async () => {
    const result = await securityScanBflaTool.handler({ url: baseUrl }, ctx);
    expect(result.content).toContain("No BFLA confirmed on /wp-admin/");
  }, 20_000);

  it("flags a heuristic BFLA when only reachable with a supplied non-admin session", async () => {
    const result = await securityScanBflaTool.handler({ url: baseUrl, headers: { Cookie: "session=nonadmin" } }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Possible Broken Function Level Authorization (Needs Manual Verification)");
    expect(result.content).toContain("/actuator");
  }, 20_000);

  it("without a session, /actuator is reported as not reachable (still login-gated)", async () => {
    const result = await securityScanBflaTool.handler({ url: baseUrl }, ctx);
    expect(result.content).not.toContain("Possible Broken Function Level Authorization");
    expect(result.content).toContain("No BFLA confirmed on /actuator");
  }, 20_000);

  it("adds an admin-keyword-matching observed endpoint as a candidate and flags it", async () => {
    const result = await securityScanBflaTool.handler(
      { url: baseUrl, observedEndpoints: [`${baseUrl}/api/internal/admin-reports`, `${baseUrl}/api/v1/products`] },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Broken Function Level Authorization (BFLA)");
    expect(result.content).toContain("/api/internal/admin-reports");
  }, 20_000);
});
