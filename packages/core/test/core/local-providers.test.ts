import { describe, expect, it } from "vitest";
import { detectLocalProviders } from "../../src/core/local-providers.js";

describe("detectLocalProviders (real network probes)", () => {
  it(
    "always resolves, and returns real, well-formed model entries for whatever's actually listening",
    async () => {
      const models = await detectLocalProviders();

      // Can't assert a fixed count — depends on what's actually running in
      // whichever environment this test executes in — but whatever comes
      // back must be real, well-formed entries, not garbage from a
      // misparsed response.
      for (const m of models) {
        expect(typeof m.id).toBe("string");
        expect(m.id.length).toBeGreaterThan(0);
        expect(typeof m.source).toBe("string");
        expect(m.baseUrl).toMatch(/^http:\/\/localhost:\d+\/v1$/);
      }
    },
    10_000,
  );

  it(
    "resolves to a plain array even when most/all candidate ports have nothing real listening — a connection " +
      "refusal or timeout on any of them is not an error, just zero results from that one",
    async () => {
      const models = await detectLocalProviders();
      expect(Array.isArray(models)).toBe(true);
    },
    10_000,
  );
});
