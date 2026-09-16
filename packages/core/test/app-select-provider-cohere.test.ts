import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { selectProvider } from "../src/app.js";
import { CohereProvider } from "../src/providers/cohere-provider.js";

// See app-select-provider-azure.test.ts's own comment on why these env vars
// must be cleared before AND after every test here.
const ENV_KEYS = ["FINANFA_PROVIDER", "FINANFA_BASE_URL", "FINANFA_MODEL", "FINANFA_API_KEY"] as const;

describe("selectProvider: provider 'cohere'", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("selects a real CohereProvider instance, defaulting the model when unset", () => {
    const { provider, defaultModel, kind } = selectProvider({ provider: "cohere", apiKey: "test-key" });
    expect(provider).toBeInstanceOf(CohereProvider);
    expect(kind).toBe("cohere");
    expect(defaultModel).toBe("command-r-plus-08-2024");
  });

  it("uses config.model when set, instead of the default", () => {
    const { defaultModel } = selectProvider({ provider: "cohere", apiKey: "test-key", model: "command-r-08-2024" });
    expect(defaultModel).toBe("command-r-08-2024");
  });

  it("throws a clear error when the API key is missing", () => {
    expect(() => selectProvider({ provider: "cohere" })).toThrow(/requires an API key/);
  });
});
