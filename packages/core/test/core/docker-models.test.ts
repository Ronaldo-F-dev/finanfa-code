import { describe, expect, it, beforeAll } from "vitest";
import { isDockerModelRunnerAvailable, listDockerModels, searchDockerModels, pullDockerModel } from "../../src/core/docker-models.js";

describe("core/docker-models (real `docker model` CLI, when present in this environment)", () => {
  let available = false;

  beforeAll(async () => {
    available = await isDockerModelRunnerAvailable();
  }, 15_000);

  it("isDockerModelRunnerAvailable resolves to a real boolean without throwing", () => {
    expect(typeof available).toBe("boolean");
  });

  it(
    "listDockerModels returns real, well-formed entries when Model Runner is available",
    async () => {
      if (!available) return; // not installed/enabled here — not this test's job to install it
      const models = await listDockerModels();
      expect(Array.isArray(models)).toBe(true);
      for (const m of models) {
        expect(typeof m.id).toBe("string");
        expect(Array.isArray(m.tags)).toBe(true);
      }
    },
    15_000,
  );

  it(
    "searchDockerModels returns real catalog entries with a query",
    async () => {
      if (!available) return;
      const results = await searchDockerModels("qwen", 5);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(typeof r.name).toBe("string");
        expect(r.name.length).toBeGreaterThan(0);
      }
    },
    20_000,
  );

  it(
    "searchDockerModels with no query lists the general catalog",
    async () => {
      if (!available) return;
      const results = await searchDockerModels(undefined, 3);
      expect(results.length).toBeGreaterThan(0);
    },
    20_000,
  );

  it(
    "pullDockerModel resolves and forwards real output lines for an already-cached model",
    async () => {
      if (!available) return;
      const installed = await listDockerModels();
      const cachedTag = installed[0]?.tags[0]?.replace(/^docker\.io\//, "");
      if (!cachedTag) return; // nothing pulled locally in this environment to test a cache-hit pull against

      const lines: string[] = [];
      await pullDockerModel(cachedTag, (line) => lines.push(line));
      expect(lines.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    "pullDockerModel rejects for a name that doesn't exist",
    async () => {
      if (!available) return;
      await expect(pullDockerModel("ai/this-model-definitely-does-not-exist-xyz123", () => {})).rejects.toThrow();
    },
    20_000,
  );
});
