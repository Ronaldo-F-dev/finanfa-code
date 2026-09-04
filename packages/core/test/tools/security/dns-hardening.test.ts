import { describe, expect, it } from "vitest";
import { securityScanDnsHardeningTool } from "../../../src/tools/builtin/security/dns-hardening.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_dns_hardening tool (real DNS queries against real domains)", () => {
  it("has 'ask' risk level", () => {
    expect(securityScanDnsHardeningTool.riskLevel).toBe("ask");
  });

  it("rejects a malformed URL", async () => {
    const result = await securityScanDnsHardeningTool.handler({ url: "not a url" }, ctx);
    expect(result.isError).toBe(true);
  });

  it(
    "discovers real, well-known subdomains for google.com (www, mail at least)",
    async () => {
      const result = await securityScanDnsHardeningTool.handler({ url: "https://google.com" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Additional Subdomains Discovered");
      expect(result.content).toContain("www.google.com");
    },
    20_000,
  );

  it(
    "reports nothing found for a domain with none of the common subdomains configured",
    async () => {
      const result = await securityScanDnsHardeningTool.handler({ url: "https://this-really-does-not-exist-finanfa-test-99999.example.com" }, ctx);
      expect(result.content).toContain("No findings");
    },
    20_000,
  );
});
