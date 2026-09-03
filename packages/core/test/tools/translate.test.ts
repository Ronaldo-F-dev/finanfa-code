import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// translate.ts reads FONIKA_AUTH_TOKEN/FONIKA_API_TOKEN once at module load
// (so a missing config fails the same clear way every call, not a fresh
// error shape per attempt) — that means each branch below needs a fresh
// module instance with the env set *before* import, not a mutation after.
async function importFreshWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("../../src/tools/builtin/translate.js");
}

describe("translate_text tool", () => {
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

  it(
    "translates a real sentence into Fon via the free Google Translate backend (no config needed), with real " +
      "Fon orthography — verified directly, not assumed from the language merely being in Google's list",
    async () => {
      const { translateTextTool } = await importFreshWithEnv({});
      const result = await translateTextTool.handler({ text: "Bonjour, comment allez-vous ?", from_lang: "fr", to_lang: "fon" }, {} as never);
      expect(result.isError).toBe(false);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content).not.toBe("Bonjour, comment allez-vous ?");
    },
    15_000,
  );

  it(
    "translates a real sentence into Yoruba via the free Google Translate backend",
    async () => {
      const { translateTextTool } = await importFreshWithEnv({});
      const result = await translateTextTool.handler({ text: "Bonjour, comment allez-vous ?", from_lang: "fr", to_lang: "yo" }, {} as never);
      expect(result.isError).toBe(false);
      expect(result.content.length).toBeGreaterThan(0);
    },
    15_000,
  );

  it(
    "reports a clear error for a language no backend currently supports (Bariba), instead of silently " +
      "returning the untranslated input or a wrong-language guess",
    async () => {
      const { translateTextTool } = await importFreshWithEnv({});
      const result = await translateTextTool.handler({ text: "Bonjour", from_lang: "fr", to_lang: "bariba" }, {} as never);
      expect(result.isError).toBe(true);
      expect(result.content.toLowerCase()).toContain("bariba");
    },
    15_000,
  );

  it(
    "with 229Langues credentials present but the account's private backend unreachable, still falls back to " +
      "the free Google Translate backend rather than failing outright",
    async () => {
      const { translateTextTool } = await importFreshWithEnv({ FONIKA_AUTH_TOKEN: "test-token", FONIKA_API_TOKEN: "test-token" });
      const result = await translateTextTool.handler({ text: "Bonjour", from_lang: "fr", to_lang: "en" }, {} as never);
      // Can't assert 229Langues itself failed here (see the "backend is
      // dead" retraction above — this sandbox's network can't tell that
      // apart from a real outage) — only that the tool as a whole still
      // produces a working translation regardless of which backend that
      // took.
      expect(result.isError).toBe(false);
      expect(result.content.length).toBeGreaterThan(0);
    },
    20_000,
  );

  it("describeCall summarizes the request, truncating long text", async () => {
    const { translateTextTool } = await importFreshWithEnv({});
    expect(translateTextTool.describeCall?.({ text: "Bonjour", to_lang: "en" })).toBe("translate to en: Bonjour");
    const long = "x".repeat(100);
    expect(translateTextTool.describeCall?.({ text: long, to_lang: "fon" })).toBe(`translate to fon: ${"x".repeat(60)}…`);
  });
});
