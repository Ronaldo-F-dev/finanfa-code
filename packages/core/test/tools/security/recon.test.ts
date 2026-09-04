import { describe, expect, it } from "vitest";
import { securityScanReconTool } from "../../../src/tools/builtin/security/recon.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_recon tool (real DNS/WHOIS/HTTP against real domains)", () => {
  it("has 'ask' risk level", () => {
    expect(securityScanReconTool.riskLevel).toBe("ask");
  });

  it("rejects a malformed URL", async () => {
    const result = await securityScanReconTool.handler({ url: "not a url" }, ctx);
    expect(result.isError).toBe(true);
  });

  it(
    "gathers real DNS records, a real WHOIS referral chain, and a real server banner for example.com",
    async () => {
      const result = await securityScanReconTool.handler({ url: "https://example.com" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("DNS resolution");
      expect(result.content).toContain("A:");
      expect(result.content).toContain("WHOIS lookup");
      expect(result.content).toContain("registrar:");
      expect(result.content).toContain("Server banner");
    },
    20_000,
  );
});
