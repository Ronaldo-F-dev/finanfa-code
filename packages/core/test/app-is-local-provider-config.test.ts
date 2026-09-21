import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { isLocalProviderConfig } from "../src/app.js";

const ENV_KEYS = ["FINANFA_PROVIDER", "FINANFA_BASE_URL", "TEXT_MODEL_PROVIDER", "TEXT_MODEL_BASE_URL"] as const;

describe("isLocalProviderConfig", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("is true for openai-compatible pointed at localhost", () => {
    expect(isLocalProviderConfig({ provider: "openai-compatible", baseUrl: "http://localhost:8001/v1" })).toBe(true);
  });

  it("is true for openai-compatible pointed at 127.0.0.1", () => {
    expect(isLocalProviderConfig({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" })).toBe(true);
  });

  it("is false for openai-compatible pointed at a real remote host", () => {
    expect(isLocalProviderConfig({ provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" })).toBe(false);
  });

  it("is false for a non-openai-compatible provider even if baseUrl happens to look local", () => {
    expect(isLocalProviderConfig({ provider: "anthropic", baseUrl: "http://localhost:8001/v1" })).toBe(false);
  });

  it("is false when no baseUrl is configured at all", () => {
    expect(isLocalProviderConfig({ provider: "openai-compatible" })).toBe(false);
  });

  it("is false for a malformed baseUrl instead of throwing", () => {
    expect(isLocalProviderConfig({ provider: "openai-compatible", baseUrl: "not a url" })).toBe(false);
  });

  it("respects FINANFA_PROVIDER/FINANFA_BASE_URL env vars over config, matching selectProvider's own precedence", () => {
    process.env.FINANFA_PROVIDER = "openai-compatible";
    process.env.FINANFA_BASE_URL = "http://127.0.0.1:8001/v1";
    expect(isLocalProviderConfig({ provider: "anthropic" })).toBe(true);
  });

  it("defaults to anthropic (never local) when nothing is configured", () => {
    expect(isLocalProviderConfig({})).toBe(false);
  });

  it("TEXT_MODEL_PROVIDER/TEXT_MODEL_BASE_URL take precedence over the older FINANFA_* names", () => {
    process.env.FINANFA_PROVIDER = "anthropic";
    process.env.TEXT_MODEL_PROVIDER = "openai-compatible";
    process.env.TEXT_MODEL_BASE_URL = "http://127.0.0.1:8080/v1";
    expect(isLocalProviderConfig({})).toBe(true);
  });

  it("recognizes llama_cpp/mlx as aliases for openai-compatible, not as their own unrecognized kind", () => {
    process.env.TEXT_MODEL_PROVIDER = "llama_cpp";
    process.env.TEXT_MODEL_BASE_URL = "http://127.0.0.1:8080/v1";
    expect(isLocalProviderConfig({})).toBe(true);
  });
});
