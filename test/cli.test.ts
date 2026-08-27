import { describe, expect, it } from "vitest";
import { BASE_SYSTEM_PROMPT, SECURITY_INSTRUCTION } from "../src/cli.js";

describe("system prompt: security instruction", () => {
  it("is present in the base system prompt sent to the model", () => {
    expect(BASE_SYSTEM_PROMPT).toContain(SECURITY_INSTRUCTION);
  });

  it("covers the key protections: authorized use, and refusing destructive/malicious use", () => {
    expect(SECURITY_INSTRUCTION).toMatch(/authorized security testing|defensive security/i);
    expect(SECURITY_INSTRUCTION).toMatch(/CTF/i);
    expect(SECURITY_INSTRUCTION).toMatch(/destructive/i);
    expect(SECURITY_INSTRUCTION).toMatch(/denial-of-service/i);
    expect(SECURITY_INSTRUCTION).toMatch(/supply-chain compromise/i);
    expect(SECURITY_INSTRUCTION).toMatch(/evading detection/i);
    expect(SECURITY_INSTRUCTION).toMatch(/authorization/i);
  });
});

describe("system prompt: path guidance", () => {
  it("tells the model to use absolute paths outside the project instead of relative traversal", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/absolute path/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/relative.*"\.\.\/"|"\.\.\/".*relative/i);
  });

  it("warns against assuming a localized standard folder name", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("Desktop");
    expect(BASE_SYSTEM_PROMPT).toContain("Bureau");
  });
});
