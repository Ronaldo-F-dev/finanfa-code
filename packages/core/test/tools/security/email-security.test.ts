import { describe, expect, it } from "vitest";
import { securityScanEmailSecurityTool } from "../../../src/tools/builtin/security/email-security.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_email_security tool (real DNS queries against real domains)", () => {
  it("has 'ask' risk level", () => {
    expect(securityScanEmailSecurityTool.riskLevel).toBe("ask");
  });

  it("rejects a malformed URL with a clear error", async () => {
    const result = await securityScanEmailSecurityTool.handler({ url: "not a url" }, ctx);
    expect(result.isError).toBe(true);
  });

  it(
    "reports google.com's real, well-known SPF (~all, not +all) and enforced DMARC (p=reject) as passed " +
      "controls, and DKIM as informational-not-confirmed (no common selector matches its real setup)",
    async () => {
      const result = await securityScanEmailSecurityTool.handler({ url: "https://google.com" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("SPF record present");
      expect(result.content).not.toContain("Missing SPF");
      expect(result.content).not.toContain("SPF Record Allows Any Sender");
      expect(result.content).toContain("DMARC enforced");
      expect(result.content).not.toContain("Missing DMARC");
      expect(result.content).toContain("DKIM Not Confirmed");
    },
    20_000,
  );

  it(
    "flags a missing SPF/DMARC for a real, definitely-unconfigured subdomain (NXDOMAIN/NODATA on both queries)",
    async () => {
      const result = await securityScanEmailSecurityTool.handler(
        { url: "https://this-really-does-not-exist-finanfa-test-12345.example.com" },
        ctx,
      );
      expect(result.content).toContain("Missing SPF Record");
      expect(result.content).toContain("Missing DMARC Record");
    },
    20_000,
  );

  it(
    "reports example.com's real SPF (-all, hard fail) and enforced DMARC (p=reject) as passed controls",
    async () => {
      const result = await securityScanEmailSecurityTool.handler({ url: "https://example.com" }, ctx);
      expect(result.content).toContain("SPF record present");
      expect(result.content).toContain("DMARC enforced");
    },
    20_000,
  );
});
