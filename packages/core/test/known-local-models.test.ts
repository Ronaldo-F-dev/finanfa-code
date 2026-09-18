import { describe, expect, it } from "vitest";
import { findKnownModelNote } from "../src/core/known-local-models.js";

describe("findKnownModelNote", () => {
  it("matches case-insensitively against a real Ollama-style model id", () => {
    expect(findKnownModelNote("lfm2.5-thinking:latest")).toContain("tool-search indirection");
    expect(findKnownModelNote("LFM2.5-THINKING:LATEST")).toContain("tool-search indirection");
  });

  it("matches a model id with an author prefix", () => {
    expect(findKnownModelNote("ducquoc/gemma4-fast-sonnet:latest")).toContain("distilled from Claude Sonnet 4.6");
  });

  it("matches Laguna-XS regardless of quantization suffix", () => {
    expect(findKnownModelNote("laguna-xs-2.1-apex-mini")).toContain("content_base64");
    expect(findKnownModelNote("Laguna-XS-2.1-APEX-I-Balanced")).toContain("content_base64");
  });

  it("matches parable/fable, an author-prefixed id with a slash", () => {
    expect(findKnownModelNote("parable/fable:latest")).toContain("Granite");
  });

  it("matches qwen2.5-coder regardless of size tag — the failure was reproduced at both 3b and 7b", () => {
    expect(findKnownModelNote("qwen2.5-coder:3b")).toContain("doesn't reliably use real function/tool calls");
    expect(findKnownModelNote("qwen2.5-coder:7b")).toContain("doesn't reliably use real function/tool calls");
  });

  it("returns undefined for a model with no known note", () => {
    expect(findKnownModelNote("llama3.2:latest")).toBeUndefined();
  });
});
