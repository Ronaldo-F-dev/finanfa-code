import { spawn } from "node:child_process";
import { SHELL, killProcessGroup } from "../util/process.js";
import type { HookAgent, HookCommand, HookEventName, HookHandler, HookMatcher, HookPrompt, HooksConfig } from "./config.js";
import { parseHookVerdict } from "./verdict.js";

export interface HookPayload {
  hook_event_name: HookEventName;
  session_id: string;
  cwd: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
  /** Stop/SubagentStop: true when a Stop hook already forced this turn to continue once — a hook should check this to avoid looping forever. */
  stop_hook_active?: boolean;
  /** SessionStart: "startup" for a fresh session, "resume" for a reopened one. SessionEnd/PreCompact: why it happened (e.g. "manual"/"auto"). */
  source?: string;
  /** Notification: the message being surfaced to the user. */
  message?: string;
}

export interface HookOutcome {
  /** "block" stops the action (PreToolUse: the tool never runs; UserPromptSubmit: the prompt is never sent); "approve" bypasses the interactive permission prompt (PreToolUse only). undefined = no hook expressed an opinion. */
  decision?: "block" | "approve";
  reason?: string;
  /** Informational text surfaced to the user (a hook's plain-text stdout when it didn't return a decision). */
  output?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_TIMEOUT_MS = 120_000;
/** The payload is embedded in an LLM prompt, so a huge tool_response must not blow up the request. */
const MAX_PAYLOAD_CHARS = 20_000;

/** What the manager gives the runner so "prompt" and "agent" hooks can reach a model. Either may be absent (no provider in this entry point). */
export interface HookLlmRunner {
  /** One model call; resolves with its reply text. */
  prompt?: (prompt: string, model: string | undefined, timeoutMs: number) => Promise<string>;
  /** A read-only sub-agent run; resolves with its final text. */
  agent?: (prompt: string, timeoutMs: number) => Promise<string>;
}

function matchesTool(matcher: HookMatcher, toolName: string | undefined): boolean {
  if (!matcher.matcher) return true;
  if (toolName === undefined) return false;
  try {
    return new RegExp(matcher.matcher).test(toolName);
  } catch {
    // An invalid regex shouldn't crash the whole hook pipeline — fall back
    // to treating it as a literal tool-name match instead.
    return matcher.matcher === toolName;
  }
}

function runOneCommand(command: HookCommand, payload: HookPayload, cwd: string): Promise<HookOutcome> {
  return new Promise((resolve) => {
    // detached + killProcessGroup: on timeout the whole process group must die,
    // not just the shell — a hook's own child (e.g. `sleep`) would otherwise
    // keep the stdout pipe open and delay "close" until it finished by itself.
    const child = spawn(command.command, { cwd, shell: SHELL, detached: true });
    let stdout = "";
    let stderr = "";
    const timeoutMs = command.timeout !== undefined ? command.timeout * 1000 : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => killProcessGroup(child), timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.stdin?.on("error", () => {}); // a hook that never reads stdin (e.g. `exit 0`) would otherwise raise EPIPE on write
    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();

    child.on("close", (code) => {
      clearTimeout(timer);
      // Real Claude Code convention: JSON on stdout with a `decision` field
      // takes precedence when present, letting a hook approve/block with a
      // structured reason. Otherwise exit code 2 blocks, using stderr as
      // the reason. Anything else (exit 0 with plain text, a nonzero code
      // that isn't 2) is "no opinion" — the normal flow proceeds, with any
      // plain-text stdout surfaced as informational output.
      const trimmedStdout = stdout.trim();
      if (trimmedStdout) {
        try {
          const parsed = JSON.parse(trimmedStdout) as { decision?: "block" | "approve"; reason?: string };
          if (parsed.decision === "block" || parsed.decision === "approve") {
            resolve({ decision: parsed.decision, reason: parsed.reason });
            return;
          }
        } catch {
          // Not JSON — treat as plain informational output below.
        }
      }
      if (code === 2) {
        resolve({ decision: "block", reason: stderr.trim() || undefined });
        return;
      }
      resolve({ output: trimmedStdout || undefined });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ output: `(hook failed to start: ${err.message})` });
    });
  });
}

function buildLlmPrompt(template: string, payload: HookPayload): string {
  let json = JSON.stringify(payload, null, 2);
  if (json.length > MAX_PAYLOAD_CHARS) json = `${json.slice(0, MAX_PAYLOAD_CHARS)}\n… (truncated)`;
  const body = template.includes("$ARGUMENTS") ? template.replaceAll("$ARGUMENTS", json) : `${template}\n\nHook input:\n${json}`;
  return (
    `${body}\n\nAnswer with a single JSON object and nothing else: {"ok": true} if the check passes, ` +
    `or {"ok": false, "reason": "<why, in one sentence>"} if it must be stopped.`
  );
}

/**
 * "prompt" and "agent" hooks. Deliberately weaker than command hooks: a model's answer can BLOCK
 * (ok:false) or say nothing, never approve — letting an LLM waive a permission prompt would turn a
 * guardrail into a bypass. Anything unusable (no model available, a failure, a reply without a
 * verdict) is "no opinion" with a note, the same convention as a command hook that fails.
 */
async function runLlmHook(handler: HookPrompt | HookAgent, payload: HookPayload, runner: HookLlmRunner | undefined): Promise<HookOutcome> {
  const isAgent = handler.type === "agent";
  const label = `${handler.type} hook`;
  const call = isAgent ? runner?.agent : runner?.prompt;
  if (!call) return { output: `(${label} skipped: no model is available in this context)` };

  const timeoutMs = handler.timeout !== undefined ? handler.timeout * 1000 : isAgent ? DEFAULT_AGENT_TIMEOUT_MS : DEFAULT_PROMPT_TIMEOUT_MS;
  const text = buildLlmPrompt(handler.prompt, payload);
  let timer: NodeJS.Timeout | undefined;
  try {
    const reply = await Promise.race([
      isAgent ? runner!.agent!(text, timeoutMs) : runner!.prompt!(text, (handler as HookPrompt).model, timeoutMs),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
    const verdict = parseHookVerdict(reply);
    if (!verdict) return { output: `(${label} gave no verdict)` };
    return verdict.ok ? {} : { decision: "block", reason: verdict.reason ?? `Blocked by a ${label}.` };
  } catch (err) {
    return { output: `(${label} failed: ${err instanceof Error ? err.message : String(err)})` };
  } finally {
    clearTimeout(timer);
  }
}

function runOneHook(handler: HookHandler, payload: HookPayload, cwd: string, runner: HookLlmRunner | undefined): Promise<HookOutcome> {
  if (handler.type === "command") return runOneCommand(handler, payload, cwd);
  if (handler.type === "prompt" || handler.type === "agent") return runLlmHook(handler, payload, runner);
  return Promise.resolve({ output: `(unknown hook type "${String((handler as { type?: unknown }).type)}" ignored)` });
}

/**
 * Runs every hook command matching `event`/`payload.tool_name`, in config
 * order, sequentially. A hook that returns a decision (block/approve)
 * short-circuits the rest — mirrors "first hook to decide wins". If
 * nothing ever decides, returns any informational stdout collected along
 * the way, joined, with no decision.
 */
export async function runHooks(config: HooksConfig, event: HookEventName, payload: HookPayload, cwd: string, runner?: HookLlmRunner): Promise<HookOutcome> {
  const matchers = config[event] ?? [];
  const outputs: string[] = [];
  for (const matcher of matchers) {
    if (!matchesTool(matcher, payload.tool_name)) continue;
    for (const command of matcher.hooks) {
      const outcome = await runOneHook(command, payload, cwd, runner);
      if (outcome.output) outputs.push(outcome.output);
      if (outcome.decision) return { decision: outcome.decision, reason: outcome.reason };
    }
  }
  return outputs.length > 0 ? { output: outputs.join("\n") } : {};
}
