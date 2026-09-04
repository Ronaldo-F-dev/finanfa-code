import { describe, expect, it } from "vitest";
import { securityScanSubdomainTakeoverTool, confirmTakeover } from "../../../src/tools/builtin/security/subdomain-takeover.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_subdomain_takeover tool", () => {
  it("has 'ask' risk level", () => {
    expect(securityScanSubdomainTakeoverTool.riskLevel).toBe("ask");
  });

  it("rejects a malformed URL with a clear error", async () => {
    const result = await securityScanSubdomainTakeoverTool.handler({ url: "not a url" }, ctx);
    expect(result.isError).toBe(true);
  });

  it(
    "reports no dangling subdomains for a real domain with no such CNAME (real public DNS, no mocks)",
    async () => {
      const result = await securityScanSubdomainTakeoverTool.handler({ url: "https://example.com" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("No dangling third-party subdomains found");
    },
    20_000,
  );

  it(
    "confirms a real takeover signature against a genuinely unclaimed GitHub Pages subdomain — real HTTP call, " +
      "real response, no mock (can't control real DNS to exercise the CNAME-discovery loop end-to-end, so this " +
      "tests the confirmation step directly, same as the loop would call it once a matching CNAME is found)",
    async () => {
      const finding = await confirmTakeover(
        "this-definitely-does-not-exist-finanfa-test-12345.github.io",
        "this-definitely-does-not-exist-finanfa-test-12345.github.io",
        { provider: "GitHub Pages", cnameSubstring: "github.io", signature: "There isn't a GitHub Pages site here" },
      );
      expect(finding).toBeDefined();
      expect(finding?.title).toContain("Subdomain Takeover");
      expect(finding?.title).toContain("GitHub Pages");
    },
    20_000,
  );

  it(
    "does not confirm a takeover against a real, live GitHub Pages site (a claimed resource)",
    async () => {
      const finding = await confirmTakeover("pages.github.com", "pages.github.com", {
        provider: "GitHub Pages",
        cnameSubstring: "github.io",
        signature: "There isn't a GitHub Pages site here",
      });
      expect(finding).toBeUndefined();
    },
    20_000,
  );
});
