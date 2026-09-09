import { describe, expect, it } from "vitest";
import { isOllamaAvailable, listOllamaModels } from "../../src/core/ollama-models.js";

// Real HTTP calls against whatever Ollama instance is actually running in
// this environment — skips gracefully if Ollama isn't installed/running
// here, same pattern as local-providers.test.ts's Docker Model Runner test.
describe("ollama-models (real Ollama server, when present)", () => {
  it("reports availability matching a direct /api/version probe", async () => {
    const available = await isOllamaAvailable();
    const direct = await fetch("http://localhost:11434/api/version", { signal: AbortSignal.timeout(800) })
      .then((r) => r.ok)
      .catch(() => false);
    expect(available).toBe(direct);
  });

  it("lists real installed models with the fields the pull/effort UI needs, when Ollama is available", async () => {
    if (!(await isOllamaAvailable())) return;
    const models = await listOllamaModels();
    expect(Array.isArray(models)).toBe(true);
    for (const m of models) {
      expect(typeof m.name).toBe("string");
      expect(typeof m.size).toBe("number");
    }
  });
});
