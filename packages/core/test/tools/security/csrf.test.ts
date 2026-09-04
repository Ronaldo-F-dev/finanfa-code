import { describe, expect, it } from "vitest";
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
