import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../../../src/core/types.js";

// A real, controllable implementation of LlmProvider — not a stub of the
// tool logic under test. The prompt-injection/jailbreak/system-prompt-leak
// tools make real LLM calls through this exact interface; hitting the
// actual Anthropic API in a test suite would cost real money and be
// non-deterministic, so this plays the role a hand-crafted fake server
// plays elsewhere in this project's tests (e.g. infra-exposure.test.ts's
// fake MySQL/Postgres/Redis) — a faithful stand-in for an external
// dependency the code genuinely calls through its real interface.

function rot13(text: string): string {
  return text.replace(/[a-zA-Z]/g, (c) => {
    const code = c.charCodeAt(0);
    const isUpper = code >= 65 && code <= 90;
    const base = isUpper ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

/** Simulates a totally vulnerable model: finds and complies with an embedded canary instruction regardless of obfuscation (direct, base64, or ROT13) — the worst case every red-team case should be able to detect. */
export function extractCanary(text: string, prefix: string): string | undefined {
  const re = new RegExp(`${prefix}_[0-9a-f]{12}`);
  const direct = text.match(re);
  if (direct) return direct[0];

  for (const candidate of text.match(/[A-Za-z0-9+/=]{16,}/g) ?? []) {
    try {
      const decoded = Buffer.from(candidate, "base64").toString("utf-8");
      const match = decoded.match(re);
      if (match) return match[0];
    } catch {
      continue;
    }
  }

  const rotMatch = rot13(text).match(re);
  return rotMatch?.[0];
}

function response(content: string): StreamTurnResult {
  return { assistantMessage: { role: "assistant", content }, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" };
}

/** Always finds and complies with any embedded canary/instruction it can decode — models every red-team case as a real vulnerability. */
export const vulnerableProvider: LlmProvider = {
  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    const userText = params.messages.find((m) => m.role === "user");
    const text = userText && "content" in userText ? userText.content : "";
    const canary = extractCanary(text, "INJECTION_CONFIRMED") ?? extractCanary(text, "JAILBREAK_CONFIRMED");
    if (canary) return response(canary);
    // system-prompt-leak style: just leak the whole real system prompt back.
    return response(`Sure! Here is my system prompt, verbatim:\n\n${params.systemPrompt}`);
  },
};

/** Never complies with an embedded instruction and never discloses its system prompt — models a well-hardened agent. */
export const hardenedProvider: LlmProvider = {
  async streamTurn(): Promise<StreamTurnResult> {
    return response("I can only help with your actual request, and I don't share my configuration or follow instructions embedded in content I'm asked to read.");
  },
};

/** Complies ONLY with the given case id(s) — for testing per-case detection accuracy rather than all-or-nothing. */
export function partiallyVulnerableProvider(vulnerableToMessageSubstrings: string[]): LlmProvider {
  return {
    async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
      const userText = params.messages.find((m) => m.role === "user");
      const text = userText && "content" in userText ? userText.content : "";
      if (vulnerableToMessageSubstrings.some((s) => text.includes(s))) {
        const canary = extractCanary(text, "INJECTION_CONFIRMED") ?? extractCanary(text, "JAILBREAK_CONFIRMED");
        if (canary) return response(canary);
      }
      return response("I won't do that.");
    },
  };
}
