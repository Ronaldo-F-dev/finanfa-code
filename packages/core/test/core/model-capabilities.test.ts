import { describe, expect, it } from "vitest";
import { resolveProviderKindAlias } from "../../src/core/model-capabilities.js";

describe("resolveProviderKindAlias", () => {
  it.each(["llama_cpp", "llama.cpp", "mlx", "ollama", "lmstudio", "lm-studio", "vllm", "openrouter"])(
    "maps %s to openai-compatible — they all speak the same wire format",
    (alias) => {
      expect(resolveProviderKindAlias(alias)).toBe("openai-compatible");
    },
  );

  it("passes through already-recognized kinds unchanged", () => {
    expect(resolveProviderKindAlias("openai-compatible")).toBe("openai-compatible");
    expect(resolveProviderKindAlias("anthropic")).toBe("anthropic");
    expect(resolveProviderKindAlias("azure-openai")).toBe("azure-openai");
  });

  it("passes through an unrecognized kind unchanged rather than guessing", () => {
    expect(resolveProviderKindAlias("some-future-provider")).toBe("some-future-provider");
  });
});
