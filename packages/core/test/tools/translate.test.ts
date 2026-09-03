import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// translate.ts reads FONIKA_AUTH_TOKEN/FONIKA_API_TOKEN once at module load
// (so a missing config fails the same clear way every call, not a fresh
// error shape per attempt) — that means the two branches below each need a
// fresh module instance with the env set *before* import, not a mutation
// after the fact.
async function importFreshWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("../../src/tools/builtin/translate.js");
}

describe("translate_text tool (real fonika_translate client, no mocks)", () => {
  const savedEnv = {
    FONIKA_AUTH_TOKEN: process.env.FONIKA_AUTH_TOKEN,
    FONIKA_API_TOKEN: process.env.FONIKA_API_TOKEN,
    FONIKA_BASE_URL: process.env.FONIKA_BASE_URL,
  };

  beforeEach(() => {
    delete process.env.FONIKA_AUTH_TOKEN;
    delete process.env.FONIKA_API_TOKEN;
    delete process.env.FONIKA_BASE_URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key as keyof typeof savedEnv];
      else process.env[key as keyof typeof savedEnv] = value;
    }
    vi.resetModules();
  });

  it("has a safe risk level", async () => {
    const { translateTextTool } = await importFreshWithEnv({});
    expect(translateTextTool.name).toBe("translate_text");
    expect(translateTextTool.riskLevel).toBe("safe");
  });

  it("reports a clear, actionable error when no credentials are configured — never attempts a network call", async () => {
    const { translateTextTool } = await importFreshWithEnv({});
    const result = await translateTextTool.handler({ text: "Bonjour", to_lang: "en" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("FONIKA_AUTH_TOKEN");
    expect(result.content).toContain("FONIKA_API_TOKEN");
  });

  it(
    "with credentials present, makes a real call against the real (currently unreachable) 229Langues backend " +
      "and surfaces the real failure instead of hanging or silently swallowing it",
    async () => {
      const { translateTextTool } = await importFreshWithEnv({ FONIKA_AUTH_TOKEN: "test-token", FONIKA_API_TOKEN: "test-token" });
      const result = await translateTextTool.handler({ text: "Bonjour", to_lang: "en", from_lang: "fr" }, {} as never);
      // Verified directly (curl + a real handler call) before writing this
      // assertion: the default backend's / (and /api/v1/translate) return a
      // real 404 HTML page, not JSON — the client's JSON.parse of that is
      // what actually throws. If the backend ever comes back online, this
      // specific message will change and this test should be revisited —
      // that's a feature, not a flake: it means translate_text started
      // actually working.
      expect(result.isError).toBe(true);
      expect(result.content).toContain("translate_text failed");
    },
    15_000,
  );

  it("describeCall summarizes the request, truncating long text", async () => {
    const { translateTextTool } = await importFreshWithEnv({});
    expect(translateTextTool.describeCall?.({ text: "Bonjour", to_lang: "en" })).toBe("translate to en: Bonjour");
    const long = "x".repeat(100);
    expect(translateTextTool.describeCall?.({ text: long, to_lang: "fon" })).toBe(`translate to fon: ${"x".repeat(60)}…`);
  });
});
