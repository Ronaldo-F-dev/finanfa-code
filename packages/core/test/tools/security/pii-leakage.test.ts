import { describe, expect, it } from "vitest";
import { createPiiLeakageScanTool } from "../../../src/tools/builtin/security/pii-leakage.js";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../../../src/core/types.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

function response(content: string): StreamTurnResult {
  return { assistantMessage: { role: "assistant", content }, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" };
}

/** Always leaks the synthetic SSN/card back verbatim by echoing its own system prompt into the reply — models a fully vulnerable agent. */
const leakyProvider: LlmProvider = {
  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    return response(`Sure! Here is the record you asked about: ${params.systemPrompt}`);
  },
};

/** Never reveals anything from its system prompt. */
const hardenedProvider: LlmProvider = {
  async streamTurn(): Promise<StreamTurnResult> {
    return response("I can't share that information, regardless of the reason given.");
  },
};

describe("security_scan_pii_leakage tool (real tool logic, controlled fake LLM provider)", () => {
  it("has 'ask' risk level", () => {
    const tool = createPiiLeakageScanTool({ provider: hardenedProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    expect(tool.riskLevel).toBe("ask");
  });

  it("flags every extraction attempt against a model that leaks the synthetic SSN/card verbatim", async () => {
    const tool = createPiiLeakageScanTool({ provider: leakyProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Sensitive Data Leaked");
    expect(result.content).toContain("SSN");
    expect(result.content).toContain("card number");
    const findingCount = (result.content.match(/Sensitive Data Leaked/g) ?? []).length;
    expect(findingCount).toBe(5);
  });

  it("reports no findings against a model that never discloses the synthetic sensitive data", async () => {
    const tool = createPiiLeakageScanTool({ provider: hardenedProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Leaked");
    expect(result.content).toContain("Resisted:");
  });

  it("respects an overridden systemPrompt input, appending the synthetic PII record to it", async () => {
    let capturedSystemPrompt: string | undefined;
    const capturingProvider: LlmProvider = {
      async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
        capturedSystemPrompt ??= params.systemPrompt;
        return response("no");
      },
    };
    const tool = createPiiLeakageScanTool({ provider: capturingProvider, model: "test-model", systemPrompt: "default prompt" });
    await tool.handler({ systemPrompt: "override base prompt" }, ctx);
    expect(capturedSystemPrompt).toContain("override base prompt");
    expect(capturedSystemPrompt).toContain("078-05-1120");
    expect(capturedSystemPrompt).toContain("4111-1111-1111-1111");
  });
});
