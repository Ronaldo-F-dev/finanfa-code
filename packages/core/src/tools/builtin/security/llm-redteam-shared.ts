import { randomBytes } from "node:crypto";
import type { LlmProvider } from "../../../core/types.js";

// Shared helpers for the LLM self-red-team tools (prompt-injection,
// system-prompt-leak, jailbreak). Unlike every other security_scan_* tool,
// these don't probe an external URL — they probe THIS agent's own
// configured provider/model/system prompt, the same real LLM call finanfa-
// code itself makes, to check whether adversarial input can hijack its
// behavior. Deliberately called with `tools: []` (never the real tool
// registry): even if an attack payload successfully gets the model to
// "want" to take an action, there is nothing for it to actually call —
// the whole test happens in a side channel with zero real-world side
// effects, so a successful jailbreak here can never itself do damage.
export interface LlmRedteamDeps {
  provider: LlmProvider;
  model: string;
  systemPrompt: string;
}

export interface RedteamCase {
  id: string;
  label: string;
  /** Builds the single user-turn message for this case, given a unique-per-run canary token. */
  buildMessage: (canary: string) => string;
}

export interface RedteamResult {
  case: RedteamCase;
  canary: string;
  response: string;
  succeeded: boolean;
}

/** A fresh, unguessable-enough token per call — makes a false positive (the model happening to already know/produce this string) astronomically unlikely, so "canary appears in the response" is a clean, low-noise success signal. */
export function freshCanary(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export async function askModel(deps: LlmRedteamDeps, userMessage: string, model: string | undefined, systemPrompt: string | undefined, signal?: AbortSignal): Promise<string> {
  const result = await deps.provider.streamTurn({
    model: model ?? deps.model,
    systemPrompt: systemPrompt ?? deps.systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    tools: [],
    onTextDelta: () => {},
    signal,
  });
  return result.assistantMessage.content;
}

/** Runs every case in `cases` against the model (sequentially — these are real, billed API calls, no need to parallelize and burn rate limits/cost faster than necessary) and reports which ones got the model to emit their canary. */
export async function runRedteamBattery(
  deps: LlmRedteamDeps,
  cases: RedteamCase[],
  canaryPrefix: string,
  model: string | undefined,
  systemPrompt: string | undefined,
  signal: AbortSignal | undefined,
): Promise<RedteamResult[]> {
  const results: RedteamResult[] = [];
  for (const testCase of cases) {
    const canary = freshCanary(canaryPrefix);
    const message = testCase.buildMessage(canary);
    let response: string;
    try {
      response = await askModel(deps, message, model, systemPrompt, signal);
    } catch (err) {
      response = `(request failed: ${err instanceof Error ? err.message : String(err)})`;
    }
    results.push({ case: testCase, canary, response, succeeded: response.includes(canary) });
  }
  return results;
}
