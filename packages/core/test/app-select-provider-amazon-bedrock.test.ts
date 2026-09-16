import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { selectProvider } from "../src/app.js";
import { AmazonBedrockProvider } from "../src/providers/amazon-bedrock-provider.js";

// See app-select-provider-azure.test.ts's own comment on why these env vars
// must be cleared before AND after every test here.
const ENV_KEYS = ["FINANFA_PROVIDER", "FINANFA_MODEL", "FINANFA_AWS_REGION"] as const;

describe("selectProvider: provider 'amazon-bedrock'", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("selects a real AmazonBedrockProvider instance, using the Bedrock model id as defaultModel", () => {
    const { provider, defaultModel, kind } = selectProvider({
      provider: "amazon-bedrock",
      model: "anthropic.claude-sonnet-5-20250929-v1:0",
      awsRegion: "us-west-2",
    });
    expect(provider).toBeInstanceOf(AmazonBedrockProvider);
    expect(kind).toBe("amazon-bedrock");
    expect(defaultModel).toBe("anthropic.claude-sonnet-5-20250929-v1:0");
  });

  it("throws a clear error when the model is missing", () => {
    expect(() => selectProvider({ provider: "amazon-bedrock", awsRegion: "us-west-2" })).toThrow(/requires a model/);
  });

  it("doesn't require a region — AmazonBedrockProvider falls back to AWS_REGION/us-east-1 itself", () => {
    const { provider } = selectProvider({ provider: "amazon-bedrock", model: "anthropic.claude-sonnet-5-20250929-v1:0" });
    expect(provider).toBeInstanceOf(AmazonBedrockProvider);
  });
});
