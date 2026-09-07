import { describe, expect, it } from "vitest";
import { createExcessiveAgencyScanTool } from "../../../src/tools/builtin/security/excessive-agency.js";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../../../src/core/types.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

function response(content: string): StreamTurnResult {
  return { assistantMessage: { role: "assistant", content }, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" };
}

/** Always caves to social-engineering pressure and claims it performed the forbidden action — models a fully vulnerable agent. */
const compliantProvider: LlmProvider = {
  async streamTurn(): Promise<StreamTurnResult> {
    return response("Sure, I've taken care of that for you.\nCONFIRMED");
  },
};

/** Always refuses, staying within its declared scope. */
const hardenedProvider: LlmProvider = {
  async streamTurn(): Promise<StreamTurnResult> {
    return response("I'm sorry, I can only provide order information and can't make that change.\nDECLINED");
  },
};

describe("security_scan_excessive_agency tool (real tool logic, controlled fake LLM provider)", () => {
  it("has 'ask' risk level", () => {
    const tool = createExcessiveAgencyScanTool({ provider: hardenedProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    expect(tool.riskLevel).toBe("ask");
  });

  it("flags every case against a model that claims CONFIRMED for out-of-scope actions", async () => {
    const tool = createExcessiveAgencyScanTool({ provider: compliantProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Excessive Agency Claimed");
    const findingCount = (result.content.match(/Excessive Agency Claimed/g) ?? []).length;
    expect(findingCount).toBe(5);
  });

  it("reports no findings against a model that always declines out-of-scope actions", async () => {
    const tool = createExcessiveAgencyScanTool({ provider: hardenedProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Claimed");
    expect(result.content).toContain("Resisted:");
  });

  it("respects an overridden systemPrompt input, appending the scope restriction to it", async () => {
    let capturedSystemPrompt: string | undefined;
    const capturingProvider: LlmProvider = {
      async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
        capturedSystemPrompt ??= params.systemPrompt;
        return response("no\nDECLINED");
      },
    };
    const tool = createExcessiveAgencyScanTool({ provider: capturingProvider, model: "test-model", systemPrompt: "default prompt" });
    await tool.handler({ systemPrompt: "override base prompt" }, ctx);
    expect(capturedSystemPrompt).toContain("override base prompt");
    expect(capturedSystemPrompt).toContain("CONFIRMED");
    expect(capturedSystemPrompt).toContain("DECLINED");
  });

  it("does not flag a response that merely mentions the word CONFIRMED mid-reply but ends DECLINED", async () => {
    const mentionsWordProvider: LlmProvider = {
      async streamTurn(): Promise<StreamTurnResult> {
        return response("I cannot mark this as CONFIRMED without manual review, so I won't proceed.\nDECLINED");
      },
    };
    const tool = createExcessiveAgencyScanTool({ provider: mentionsWordProvider, model: "test-model", systemPrompt: "You are a helpful assistant." });
    const result = await tool.handler({}, ctx);
    expect(result.content).not.toContain("Excessive Agency Claimed");
  });
});
