import { describe, expect, it } from "vitest";
import { BASE_SYSTEM_PROMPT, LOCAL_MODEL_LEAN_SYSTEM_PROMPT, baseSystemPromptFor } from "../src/app.js";

// Real, reported symptom this closes: a tiny local model (Ternary-Bonsai
// 1.7B/4B via llama.cpp) given the full BASE_SYSTEM_PROMPT answered a plain
// "bonjour" with an off-topic, incoherent refusal fixated on the security
// paragraph — overwhelmed by a prompt written for a much larger model.
// baseSystemPromptFor(localModelLeanEnabled) is the single switch point;
// every call site passes it the exact same boolean already computed for
// session.localModelLeanEnabled (resolveLocalModelLeanEnabled +
// isLocalProviderConfig), so the prompt and the tool-trimming gate can
// never disagree about whether a session counts as "local".
describe("baseSystemPromptFor", () => {
  it("returns the full BASE_SYSTEM_PROMPT, unchanged, when local-model-lean is off (non-local/remote sessions)", () => {
    expect(baseSystemPromptFor(false)).toBe(BASE_SYSTEM_PROMPT);
  });

  it("returns the leaner prompt when local-model-lean is on", () => {
    expect(baseSystemPromptFor(true)).toBe(LOCAL_MODEL_LEAN_SYSTEM_PROMPT);
    expect(baseSystemPromptFor(true)).not.toBe(BASE_SYSTEM_PROMPT);
  });

  // Regression guard: nothing about this feature is allowed to touch the
  // big/remote-model prompt. If a future edit accidentally shares text or
  // shortens BASE_SYSTEM_PROMPT itself, this catches it.
  it("BASE_SYSTEM_PROMPT itself keeps every load-bearing section (identity, security, test/fix loop)", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("You are finanfa-code");
    expect(BASE_SYSTEM_PROMPT).toContain("Security:");
    expect(BASE_SYSTEM_PROMPT).toContain("test/fix loop");
    expect(BASE_SYSTEM_PROMPT.length).toBeGreaterThan(5000);
  });
});

describe("LOCAL_MODEL_LEAN_SYSTEM_PROMPT", () => {
  it("is substantially shorter than the full prompt", () => {
    expect(LOCAL_MODEL_LEAN_SYSTEM_PROMPT.length).toBeLessThan(BASE_SYSTEM_PROMPT.length / 4);
  });

  it("still states the agent's identity", () => {
    expect(LOCAL_MODEL_LEAN_SYSTEM_PROMPT).toContain("You are finanfa-code");
  });

  it("keeps a clear security-refusal instruction instead of dropping it entirely", () => {
    expect(LOCAL_MODEL_LEAN_SYSTEM_PROMPT).toMatch(/Security:/);
    expect(LOCAL_MODEL_LEAN_SYSTEM_PROMPT).toMatch(/decline/i);
  });

  it("keeps the test/fix loop discipline (run tests, fix the real cause, stop after repeated failures)", () => {
    expect(LOCAL_MODEL_LEAN_SYSTEM_PROMPT).toMatch(/run_tests/);
    expect(LOCAL_MODEL_LEAN_SYSTEM_PROMPT).toMatch(/3 fix attempts/);
  });

  it("drops the heavier sections not needed for basic local-model coding reliability", () => {
    expect(LOCAL_MODEL_LEAN_SYSTEM_PROMPT).not.toContain("preview_html");
    expect(LOCAL_MODEL_LEAN_SYSTEM_PROMPT).not.toContain("mcp__github__");
    expect(LOCAL_MODEL_LEAN_SYSTEM_PROMPT).not.toContain("read_document");
  });
});
