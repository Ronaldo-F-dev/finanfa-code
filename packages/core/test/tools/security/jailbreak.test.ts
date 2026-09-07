import { describe, expect, it } from "vitest";
import { createJailbreakScanTool } from "../../../src/tools/builtin/security/jailbreak.js";
import { vulnerableProvider, hardenedProvider, partiallyVulnerableProvider } from "./redteam-fake-provider.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_jailbreak tool (real tool logic, controlled fake LLM provider)", () => {
  it("has 'ask' risk level", () => {
    const tool = createJailbreakScanTool({ provider: hardenedProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    expect(tool.riskLevel).toBe("ask");
  });

  it("flags every case against a fully vulnerable model that decodes and complies with any override attempt, including base64/ROT13", async () => {
    const tool = createJailbreakScanTool({ provider: vulnerableProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Jailbreak Succeeded");
    const findingCount = (result.content.match(/Jailbreak Succeeded/g) ?? []).length;
    expect(findingCount).toBe(7);
  });

  it("reports no findings against a hardened model that resists every override attempt", async () => {
    const tool = createJailbreakScanTool({ provider: hardenedProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Succeeded");
    expect(result.content).toContain("Resisted:");
  });

  it("flags only the DAN-style roleplay case for a model vulnerable to just that framing", async () => {
    const tool = createJailbreakScanTool({
      provider: partiallyVulnerableProvider(["DAN"]),
      model: "test-model",
      systemPrompt: "You are a helpful assistant.",
    });
    const result = await tool.handler({}, ctx);
    expect(result.content).toContain("DAN-style 'no restrictions' roleplay");
    const findingCount = (result.content.match(/Jailbreak Succeeded/g) ?? []).length;
    expect(findingCount).toBe(1);
  });
});
