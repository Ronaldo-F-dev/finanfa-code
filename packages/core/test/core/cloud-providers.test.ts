import { afterEach, describe, expect, it } from "vitest";
import { CLOUD_PROVIDERS, cloudApiKey, cloudProviderForBaseUrl } from "../../src/core/cloud-providers.js";

const deepseek = CLOUD_PROVIDERS.find((p) => p.id === "deepseek")!;

afterEach(() => {
  delete process.env[deepseek.envKey];
});

describe("cloud providers", () => {
  it("recognises a provider by its base URL, trailing slash or not, and never a local server", () => {
    expect(cloudProviderForBaseUrl("https://api.deepseek.com")?.id).toBe("deepseek");
    expect(cloudProviderForBaseUrl("https://api.x.ai/v1/")?.id).toBe("xai");
    expect(cloudProviderForBaseUrl("http://localhost:11434/v1")).toBeUndefined();
    expect(cloudProviderForBaseUrl(undefined)).toBeUndefined();
  });

  it("takes the key from the environment first, then the saved one, and has none otherwise", () => {
    expect(cloudApiKey(deepseek, {})).toBeUndefined();
    expect(cloudApiKey(deepseek, { deepseekApiKey: "saved" })).toBe("saved");
    process.env[deepseek.envKey] = "from-env";
    expect(cloudApiKey(deepseek, { deepseekApiKey: "saved" })).toBe("from-env");
  });

  it("gives every provider at least one model and a distinct base URL", () => {
    expect(CLOUD_PROVIDERS.every((p) => p.models.length > 0)).toBe(true);
    expect(new Set(CLOUD_PROVIDERS.map((p) => p.baseUrl)).size).toBe(CLOUD_PROVIDERS.length);
  });
});
