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
