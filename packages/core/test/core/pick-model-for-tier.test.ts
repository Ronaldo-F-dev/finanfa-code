import { describe, expect, it } from "vitest";
import { pickModelForTier, type LocalModelInfo } from "../../src/core/effort-tiers.js";

const base = "http://localhost:11434/v1";
const models: LocalModelInfo[] = [
  { name: "nomic-embed-text", baseUrl: base, size: 270e6, supportsTools: false },
  { name: "gemma2:2b", baseUrl: base, size: 1.6e9, supportsTools: false },
  { name: "qwen3:8b", baseUrl: base, size: 5.2e9, supportsTools: true },
  { name: "qwen3:4b", baseUrl: base, size: 2.5e9, supportsTools: true },
  { name: "served-elsewhere", baseUrl: "http://localhost:1234/v1" },
];

describe("pickModelForTier", () => {
  it("low takes the smallest chat model, never an embedding model", () => {
    expect(pickModelForTier("low", models)?.name).toBe("gemma2:2b");
  });
  it("medium takes the smallest model known to support tools", () => {
    expect(pickModelForTier("medium", models)?.name).toBe("qwen3:4b");
  });
  it("is undefined when nothing fits, so the level is unavailable rather than a download", () => {
    expect(pickModelForTier("medium", [models[1]!, models[4]!])).toBeUndefined();
    expect(pickModelForTier("low", [])).toBeUndefined();
  });
  it("still finds a model whose size is unknown", () => {
    expect(pickModelForTier("low", [models[4]!])?.name).toBe("served-elsewhere");
  });
});
