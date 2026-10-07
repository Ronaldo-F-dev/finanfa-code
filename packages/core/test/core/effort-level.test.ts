import { describe, expect, it } from "vitest";
import { effortPromptFor, isEffortLevel, thinkingBudgetFor } from "../../src/core/effort-level.js";
import { reasoningEffortParam } from "../../src/core/cloud-providers.js";
import { anthropicMaxTokens } from "../../src/providers/anthropic-provider.js";

describe("effort level", () => {
  it("accepts exactly low, medium and high", () => {
    expect(["low", "medium", "high"].every(isEffortLevel)).toBe(true);
    expect(isEffortLevel("legal")).toBe(false);
    expect(isEffortLevel(undefined)).toBe(false);
  });

  it("turns extended thinking off at low and grows the budget with the level", () => {
    expect(thinkingBudgetFor("low")).toBeUndefined();
    expect(thinkingBudgetFor("medium")!).toBeGreaterThanOrEqual(1024);
    expect(thinkingBudgetFor("high")!).toBeGreaterThan(thinkingBudgetFor("medium")!);
  });

  it("only adds a system prompt line for low and high", () => {
    expect(effortPromptFor("low")).toMatch(/low/);
    expect(effortPromptFor("high")).toMatch(/high/);
    expect(effortPromptFor("medium")).toBe("");
    expect(effortPromptFor(undefined)).toBe("");
  });

  it("sends reasoning_effort to Gemini only, never to a local or unknown server", () => {
    expect(reasoningEffortParam("https://generativelanguage.googleapis.com/v1beta/openai", "high")).toBe("high");
    expect(reasoningEffortParam("http://localhost:11434/v1", "high")).toBeUndefined();
    expect(reasoningEffortParam("https://api.deepseek.com", "low")).toBeUndefined();
    expect(reasoningEffortParam("https://generativelanguage.googleapis.com/v1beta/openai", undefined)).toBeUndefined();
  });

  it("leaves room for the answer on top of the thinking budget, unless max_tokens was set explicitly", () => {
    expect(anthropicMaxTokens({})).toBe(8192);
    const budget = thinkingBudgetFor("high")!;
    expect(anthropicMaxTokens({ thinkingBudgetTokens: budget })).toBeGreaterThan(budget);
    expect(anthropicMaxTokens({ thinkingBudgetTokens: budget, maxTokens: 30000 })).toBe(30000);
  });
});
