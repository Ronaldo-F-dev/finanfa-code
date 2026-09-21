import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { selectProvider } from "../src/app.js";
import { OpenAiCompatibleProvider } from "../src/providers/openai-compatible-provider.js";

// Real dev-shell exports (see app-select-provider-gemini.test.ts's own note)
// take priority over what a test passes in directly, so every one of these
// — old FINANFA_* names and the new TEXT_MODEL_* ones alike — must be
// cleared before and after every test here.
const ENV_KEYS = [
  "FINANFA_PROVIDER",
  "FINANFA_BASE_URL",
  "FINANFA_MODEL",
  "FINANFA_API_KEY",
  "TEXT_MODEL_PROVIDER",
  "TEXT_MODEL_BASE_URL",
  "TEXT_MODEL_NAME",
] as const;

describe("selectProvider: provider 'openai-compatible' (the local-first text model slot)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("selects a real OpenAiCompatibleProvider from config.baseUrl/model", () => {
    const { provider, defaultModel, kind } = selectProvider({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "Ternary-Bonsai-1.7B-Q2_0_g64",
    });
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(kind).toBe("openai-compatible");
    expect(defaultModel).toBe("Ternary-Bonsai-1.7B-Q2_0_g64");
  });

  it("throws a clear error when baseUrl/model are missing", () => {
    expect(() => selectProvider({ provider: "openai-compatible" })).toThrow(/requires a base URL and model/);
  });

  it("TEXT_MODEL_PROVIDER/TEXT_MODEL_BASE_URL/TEXT_MODEL_NAME select the local text model over config", () => {
    process.env.TEXT_MODEL_PROVIDER = "openai-compatible";
    process.env.TEXT_MODEL_BASE_URL = "http://127.0.0.1:8080/v1";
    process.env.TEXT_MODEL_NAME = "Ternary-Bonsai-1.7B-Q2_0_g64";
    const { defaultModel, kind } = selectProvider({ provider: "anthropic" });
    expect(kind).toBe("openai-compatible");
    expect(defaultModel).toBe("Ternary-Bonsai-1.7B-Q2_0_g64");
  });

  it("TEXT_MODEL_PROVIDER=llama_cpp resolves the same as openai-compatible", () => {
    process.env.TEXT_MODEL_PROVIDER = "llama_cpp";
    process.env.TEXT_MODEL_BASE_URL = "http://127.0.0.1:8080/v1";
    process.env.TEXT_MODEL_NAME = "Ternary-Bonsai-1.7B-Q2_0_g64";
    const { provider, kind } = selectProvider({});
    expect(kind).toBe("openai-compatible");
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
  });

  it("TEXT_MODEL_* takes precedence over the older FINANFA_* names when both are set", () => {
    process.env.FINANFA_PROVIDER = "openai-compatible";
    process.env.FINANFA_BASE_URL = "http://127.0.0.1:9999/v1";
    process.env.FINANFA_MODEL = "old-model";
    process.env.TEXT_MODEL_BASE_URL = "http://127.0.0.1:8080/v1";
    process.env.TEXT_MODEL_NAME = "Ternary-Bonsai-1.7B-Q2_0_g64";
    const { defaultModel } = selectProvider({});
    expect(defaultModel).toBe("Ternary-Bonsai-1.7B-Q2_0_g64");
  });
});
