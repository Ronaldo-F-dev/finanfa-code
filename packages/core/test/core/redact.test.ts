import { describe, expect, it } from "vitest";
import { collectEnvSecretValues, redactSecrets } from "../../src/core/redact.js";

describe("redactSecrets", () => {
  it("masks a known secret-shaped pattern (AWS access key)", () => {
    const result = redactSecrets("your key is AKIAABCDEFGHIJKLMNOP, keep it safe");
    expect(result).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result).toContain("***");
  });

  it("masks every occurrence of an exact denylisted value", () => {
    const result = redactSecrets("token=sk-real-secret-value-123 and again sk-real-secret-value-123", ["sk-real-secret-value-123"]);
    expect(result).not.toContain("sk-real-secret-value-123");
    expect(result.match(/\*/)?.length).toBeGreaterThan(0);
  });

  it("leaves ordinary text untouched", () => {
    expect(redactSecrets("just a normal tool result with no secrets in it")).toBe("just a normal tool result with no secrets in it");
  });

  it("doesn't throw for a 9- or 10-character denylisted value (real bug: mask()'s slice(0,6)+slice(-4) scheme needs length > 10 to have any middle left to mask, and 'undefined'.length === 9)", () => {
    // Reproduces the exact real-world trigger: a test elsewhere restoring
    // `process.env.X = originalValue` where originalValue was undefined
    // sets X to the literal string "undefined" (Node doesn't unset it),
    // which then flows into the denylist here on every later persist().
    expect(() => redactSecrets("some text", ["undefined"])).not.toThrow();
    expect(() => redactSecrets("some text", ["1234567890"])).not.toThrow();
  });
});

describe("collectEnvSecretValues", () => {
  it("returns configured secret env var values, skipping unset ones", () => {
    const values = collectEnvSecretValues({ ANTHROPIC_API_KEY: "sk-ant-1234567890" } as NodeJS.ProcessEnv);
    expect(values).toEqual(["sk-ant-1234567890"]);
  });

  it("skips short values (likely test placeholders, not real secrets)", () => {
    expect(collectEnvSecretValues({ ANTHROPIC_API_KEY: "short" } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("splits FINANFA_API_KEYS on commas", () => {
    const values = collectEnvSecretValues({ FINANFA_API_KEYS: "key-one-12345, key-two-67890" } as NodeJS.ProcessEnv);
    expect(values).toEqual(["key-one-12345", "key-two-67890"]);
  });
});
