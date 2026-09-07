import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { selectProvider } from "../src/app.js";
import { GeminiProvider } from "../src/providers/gemini-provider.js";

// This real dev shell exports FINANFA_PROVIDER/FINANFA_MODEL/FINANFA_API_KEY
// for manual testing against a real inference endpoint (confirmed while
// debugging cli-prompt-mode.test.ts earlier) — selectProvider() reads
// those with priority over what a test passes in directly, so they must
// be cleared before (not just after) every test here too.
const ENV_KEYS = ["FINANFA_PROVIDER", "FINANFA_API_KEY", "FINANFA_MODEL"] as const;

describe("selectProvider: provider 'gemini'", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("selects a real GeminiProvider instance for provider: 'gemini' with an API key", () => {
    const { provider, defaultModel, kind } = selectProvider({ provider: "gemini", apiKey: "test-key" });
    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(kind).toBe("gemini");
    expect(defaultModel).toBe("gemini-2.5-flash");
  });

  it("uses config.model to override the default Gemini model", () => {
    const { defaultModel } = selectProvider({ provider: "gemini", apiKey: "test-key", model: "gemini-2.5-pro" });
    expect(defaultModel).toBe("gemini-2.5-pro");
  });

  it("throws a clear error when no API key is configured", () => {
    expect(() => selectProvider({ provider: "gemini" })).toThrow(/requires an API key/);
  });

  it("FINANFA_PROVIDER env var selects gemini over config.provider", () => {
    process.env.FINANFA_PROVIDER = "gemini";
    process.env.FINANFA_API_KEY = "env-key";
    const { kind } = selectProvider({ provider: "anthropic" });
    expect(kind).toBe("gemini");
  });
});
