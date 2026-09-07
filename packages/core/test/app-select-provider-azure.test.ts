import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { selectProvider } from "../src/app.js";
import { AzureOpenAiProvider } from "../src/providers/azure-openai-provider.js";

// This real dev shell exports FINANFA_PROVIDER/FINANFA_BASE_URL/
// FINANFA_MODEL/FINANFA_API_KEY for manual testing against a real
// inference endpoint (confirmed while debugging cli-prompt-mode.test.ts
// earlier) — selectProvider() reads those with priority over what a
// test passes in directly, so they must be cleared before AND after
// every test here.
const ENV_KEYS = ["FINANFA_PROVIDER", "FINANFA_BASE_URL", "FINANFA_MODEL", "FINANFA_API_KEY", "FINANFA_AZURE_API_VERSION"] as const;

describe("selectProvider: provider 'azure-openai'", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("selects a real AzureOpenAiProvider instance, using the deployment name as defaultModel", () => {
    const { provider, defaultModel, kind } = selectProvider({
      provider: "azure-openai",
      baseUrl: "https://my-resource.openai.azure.com",
      model: "my-gpt4o-deployment",
      apiKey: "test-key",
    });
    expect(provider).toBeInstanceOf(AzureOpenAiProvider);
    expect(kind).toBe("azure-openai");
    expect(defaultModel).toBe("my-gpt4o-deployment");
  });

  it("throws a clear error when the endpoint is missing", () => {
    expect(() => selectProvider({ provider: "azure-openai", model: "dep", apiKey: "k" })).toThrow(/requires an endpoint/);
  });

  it("throws a clear error when the deployment (model) is missing", () => {
    expect(() => selectProvider({ provider: "azure-openai", baseUrl: "https://x.openai.azure.com", apiKey: "k" })).toThrow(/requires an endpoint/);
  });

  it("throws a clear error when the API key is missing", () => {
    expect(() => selectProvider({ provider: "azure-openai", baseUrl: "https://x.openai.azure.com", model: "dep" })).toThrow(/requires an endpoint/);
  });
});
