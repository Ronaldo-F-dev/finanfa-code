import { describe, expect, it } from "vitest";
import { createPromptInjectionScanTool } from "../../../src/tools/builtin/security/prompt-injection.js";
import { vulnerableProvider, hardenedProvider, partiallyVulnerableProvider } from "./redteam-fake-provider.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("security_scan_prompt_injection tool (real tool logic, controlled fake LLM provider)", () => {
  it("has 'ask' risk level", () => {
    const tool = createPromptInjectionScanTool({ provider: hardenedProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    expect(tool.riskLevel).toBe("ask");
  });

  it("flags every case against a fully vulnerable model that decodes and complies with any embedded instruction", async () => {
    const tool = createPromptInjectionScanTool({ provider: vulnerableProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Indirect Prompt Injection Succeeded");
    expect(result.content).toContain("finding(s)");
    // all 7 cases should be caught, including the obfuscated ones
    const findingCount = (result.content.match(/Indirect Prompt Injection Succeeded/g) ?? []).length;
    expect(findingCount).toBe(7);
  });

  it("reports no findings against a hardened model that never follows embedded instructions", async () => {
    const tool = createPromptInjectionScanTool({ provider: hardenedProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Succeeded");
    expect(result.content).toContain("Resisted:");
  });

  it("flags only the specific case a partially-vulnerable model is susceptible to", async () => {
    const tool = createPromptInjectionScanTool({
      provider: partiallyVulnerableProvider(["[SYSTEM]:"]),
      model: "test-model",
      systemPrompt: "You are a helpful assistant.",
    });
    const result = await tool.handler({}, ctx);
    expect(result.content).toContain("Fake [SYSTEM] tag embedded in content");
    const findingCount = (result.content.match(/Indirect Prompt Injection Succeeded/g) ?? []).length;
    expect(findingCount).toBe(1);
  });

  it("respects an overridden model/systemPrompt input over the deps default", async () => {
    let capturedSystemPrompt: string | undefined;
    const capturingProvider = {
      async streamTurn(params: { systemPrompt: string; messages: { role: string; content?: string }[] }) {
        capturedSystemPrompt = params.systemPrompt;
        return { assistantMessage: { role: "assistant" as const, content: "just a summary" }, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" as const };
      },
    };
    const tool = createPromptInjectionScanTool({ provider: capturingProvider, model: "default-model", systemPrompt: "default prompt" });
    await tool.handler({ systemPrompt: "override prompt" }, ctx);
    expect(capturedSystemPrompt).toBe("override prompt");
  });
});
