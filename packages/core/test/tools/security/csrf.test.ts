import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityScanCsrfTool } from "../../../src/tools/builtin/security/csrf.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_csrf tool (pure structural check, no network)", () => {
  it("has 'ask' risk level", () => {
    expect(securityScanCsrfTool.riskLevel).toBe("ask");
  });

  it("flags a form with no CSRF-token-shaped field", async () => {
    const result = await securityScanCsrfTool.handler(
      { pageUrl: "https://example.com/settings", formAction: "https://example.com/settings/update", fieldNames: ["email", "password"] },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Form Missing CSRF Token");
  });

  it("passes when a csrf_token-shaped field is present", async () => {
    const result = await securityScanCsrfTool.handler(
      { pageUrl: "https://example.com/settings", formAction: "https://example.com/settings/update", fieldNames: ["email", "csrf_token"] },
      ctx,
    );
    expect(result.content).toContain("CSRF token present");
    expect(result.content).not.toContain("Missing CSRF Token");
  });

  it("recognizes other common token field names (authenticity_token, RequestVerificationToken)", async () => {
    const rails = await securityScanCsrfTool.handler({ pageUrl: "https://example.com", formAction: "https://example.com/x", fieldNames: ["authenticity_token"] }, ctx);
    expect(rails.content).toContain("CSRF token present");

    const dotnet = await securityScanCsrfTool.handler(
      { pageUrl: "https://example.com", formAction: "https://example.com/x", fieldNames: ["__RequestVerificationToken"] },
      ctx,
    );
    expect(dotnet.content).toContain("CSRF token present");
  });

  it("reports nothing to check for a form with no fields at all", async () => {
    const result = await securityScanCsrfTool.handler({ pageUrl: "https://example.com", formAction: "https://example.com/x", fieldNames: [] }, ctx);
    expect(result.content).toContain("No fields given");
  });
});

describe("security_scan_csrf tool active mode (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.headers.cookie !== "session=valid") {
        res.writeHead(401).end("unauthorized");
        return;
      }
      if (req.url === "/vulnerable/update") {
        // Accepts the submission regardless of Origin — exploitable.
        res.writeHead(200).end("updated");
        return;
      }
      if (req.url === "/protected/update") {
        // Validates Origin/Referer server-side despite no token field.
        const origin = req.headers.origin;
        if (origin && origin.includes("finanfa-code.invalid")) {
          res.writeHead(403).end("forbidden: bad origin");
          return;
        }
        res.writeHead(200).end("updated");
        return;
      }
      if (req.url === "/rejects-baseline/update") {
        // The baseline submission itself doesn't succeed (bad request
        // regardless of Origin) — the active test must be inconclusive.
        res.writeHead(400).end("bad request");
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

  it("confirms CSRF for real when the server accepts a forged Origin identically", async () => {
    const result = await securityScanCsrfTool.handler(
      {
        pageUrl: `${baseUrl}/vulnerable`,
        formAction: `${baseUrl}/vulnerable/update`,
        fieldNames: ["email"],
        fieldTypes: { email: "email" },
        headers: { Cookie: "session=valid" },
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Cross-Site Request Forgery (CSRF) Confirmed");
  });

  it("does not flag a form whose server validates Origin/Referer despite no token field", async () => {
    const result = await securityScanCsrfTool.handler(
      {
        pageUrl: `${baseUrl}/protected`,
        formAction: `${baseUrl}/protected/update`,
        fieldNames: ["email"],
        fieldTypes: { email: "email" },
        headers: { Cookie: "session=valid" },
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Confirmed");
    expect(result.content).toContain("CSRF not exploitable");
  });

  it("falls back to the passive heuristic finding when the baseline submission itself fails", async () => {
    const result = await securityScanCsrfTool.handler(
      {
        pageUrl: `${baseUrl}/rejects-baseline`,
        formAction: `${baseUrl}/rejects-baseline/update`,
        fieldNames: ["email"],
        fieldTypes: { email: "email" },
        headers: { Cookie: "session=valid" },
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Form Missing CSRF Token (Needs Manual Verification)");
  });
});
