import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { selectVisionProvider } from "../src/app.js";
import { OpenAiCompatibleProvider } from "../src/providers/openai-compatible-provider.js";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";

const ENV_KEYS = [
  "FINANFA_VISION_PROVIDER",
  "FINANFA_VISION_BASE_URL",
  "FINANFA_VISION_MODEL",
  "FINANFA_VISION_API_KEY",
  "VISION_MODEL_PROVIDER",
  "VISION_MODEL_BASE_URL",
  "VISION_MODEL_NAME",
] as const;

describe("selectVisionProvider", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("is undefined when no vision model is configured at all", () => {
    expect(selectVisionProvider({})).toBeUndefined();
  });

  it("builds a real OpenAiCompatibleProvider from config.visionBaseUrl/visionModel", () => {
    const result = selectVisionProvider({
      visionProvider: "openai-compatible",
      visionBaseUrl: "http://127.0.0.1:8081/v1",
      visionModel: "Ternary-Bonsai-27B",
    });
    expect(result?.provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(result?.model).toBe("Ternary-Bonsai-27B");
  });

  it("defaults to AnthropicProvider when visionProvider isn't set but visionModel is", () => {
    const result = selectVisionProvider({ visionModel: "claude-opus-5" });
    expect(result?.provider).toBeInstanceOf(AnthropicProvider);
  });

  it("VISION_MODEL_PROVIDER/VISION_MODEL_BASE_URL/VISION_MODEL_NAME select the local vision model over config", () => {
    process.env.VISION_MODEL_PROVIDER = "mlx";
    process.env.VISION_MODEL_BASE_URL = "http://127.0.0.1:8081/v1";
    process.env.VISION_MODEL_NAME = "Ternary-Bonsai-27B-mlx-2bit";
    const result = selectVisionProvider({});
    expect(result?.provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(result?.model).toBe("Ternary-Bonsai-27B-mlx-2bit");
  });

  it("VISION_MODEL_* takes precedence over the older FINANFA_VISION_* names when both are set", () => {
    process.env.FINANFA_VISION_MODEL = "old-vision-model";
    process.env.VISION_MODEL_NAME = "Ternary-Bonsai-27B-mlx-2bit";
    const result = selectVisionProvider({});
    expect(result?.model).toBe("Ternary-Bonsai-27B-mlx-2bit");
  });

  it("throws a clear error when the openai-compatible vision provider has no base URL", () => {
    process.env.VISION_MODEL_NAME = "Ternary-Bonsai-27B-mlx-2bit";
    process.env.VISION_MODEL_PROVIDER = "mlx";
    expect(() => selectVisionProvider({})).toThrow(/requires a base URL/);
  });
});
