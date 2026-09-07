import { spawn } from "node:child_process";
import { SHELL } from "../util/process.js";
import type { HookCommand, HookEventName, HookMatcher, HooksConfig } from "./config.js";

export interface HookPayload {
  hook_event_name: HookEventName;
  session_id: string;
  cwd: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
}

export interface HookOutcome {
  /** "block" stops the action (PreToolUse: the tool never runs; UserPromptSubmit: the prompt is never sent); "approve" bypasses the interactive permission prompt (PreToolUse only). undefined = no hook expressed an opinion. */
  decision?: "block" | "approve";
  reason?: string;
  /** Informational text surfaced to the user (a hook's plain-text stdout when it didn't return a decision). */
  output?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

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
    const child = spawn(command.command, { cwd, shell: SHELL });
    let stdout = "";
    let stderr = "";
    const timeoutMs = command.timeout !== undefined ? command.timeout * 1000 : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

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

/**
 * Runs every hook command matching `event`/`payload.tool_name`, in config
 * order, sequentially. A hook that returns a decision (block/approve)
 * short-circuits the rest — mirrors "first hook to decide wins". If
 * nothing ever decides, returns any informational stdout collected along
 * the way, joined, with no decision.
 */
export async function runHooks(config: HooksConfig, event: HookEventName, payload: HookPayload, cwd: string): Promise<HookOutcome> {
  const matchers = config[event] ?? [];
  const outputs: string[] = [];
  for (const matcher of matchers) {
    if (!matchesTool(matcher, payload.tool_name)) continue;
    for (const command of matcher.hooks) {
      const outcome = await runOneCommand(command, payload, cwd);
      if (outcome.output) outputs.push(outcome.output);
      if (outcome.decision) return { decision: outcome.decision, reason: outcome.reason };
    }
  }
  return outputs.length > 0 ? { output: outputs.join("\n") } : {};
}
