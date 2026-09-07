import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Claude Code's own hooks feature: user- or project-configured shell
// commands that run at specific points in the agent loop (before a tool
// runs, after it runs, when the user submits a prompt) and can observe or
// influence what happens next. Config shape intentionally mirrors real
// Claude Code's hooks.json/settings.json `hooks` field so a user already
// familiar with that convention (matcher + array of {type: "command",
// command, timeout?}) can reuse the same mental model here.
export type HookEventName = "PreToolUse" | "PostToolUse" | "UserPromptSubmit";

export interface HookCommand {
  type: "command";
  command: string;
  /** Seconds. Defaults to 60 if omitted — see runner.ts. */
  timeout?: number;
}

export interface HookMatcher {
  /** Regex tested against the tool name (PreToolUse/PostToolUse only). Omitted matches every tool. Ignored for UserPromptSubmit. */
  matcher?: string;
  hooks: HookCommand[];
}

export interface HooksConfig {
  PreToolUse?: HookMatcher[];
  PostToolUse?: HookMatcher[];
  UserPromptSubmit?: HookMatcher[];
}

export const EMPTY_HOOKS_CONFIG: HooksConfig = {};

interface ConfigFileWithHooks {
  hooks?: HooksConfig;
}

async function readHooksFromFile(file: string): Promise<HooksConfig | undefined> {
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as ConfigFileWithHooks;
    return parsed.hooks;
  } catch (err) {
    // Same fail-loud-but-not-fatal convention as permissions/config.ts: a
    // missing file is normal and silent, anything else (malformed JSON, a
    // permission error) is worth a diagnostic since it silently drops
    // whatever hooks the user configured.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`Warning: failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  }
}

function mergeEvent(global: HookMatcher[] | undefined, project: HookMatcher[] | undefined): HookMatcher[] | undefined {
  if (!global && !project) return undefined;
  return [...(global ?? []), ...(project ?? [])];
}

/**
 * `trusted` gates whether the PROJECT-level settings.json's hooks are read
 * at all — see core/trust.ts. This matters even more here than for plain
 * permission rules: an untrusted project's PreToolUse hook could return
 * {"decision":"approve"} and silently bypass every confirmation prompt.
 * Defaults to true so every existing caller/test keeps its prior behavior
 * unless it opts into the gate.
 */
export async function loadHooksConfig(cwd: string, trusted = true): Promise<HooksConfig> {
  const globalFile = path.join(os.homedir(), ".finanfa-code", "config.json");
  const projectFile = path.join(cwd, ".finanfa-code", "settings.json");

  const [globalHooks, projectHooks] = await Promise.all([readHooksFromFile(globalFile), trusted ? readHooksFromFile(projectFile) : Promise.resolve(undefined)]);
  if (!globalHooks && !projectHooks) return EMPTY_HOOKS_CONFIG;

  return {
    PreToolUse: mergeEvent(globalHooks?.PreToolUse, projectHooks?.PreToolUse),
    PostToolUse: mergeEvent(globalHooks?.PostToolUse, projectHooks?.PostToolUse),
    UserPromptSubmit: mergeEvent(globalHooks?.UserPromptSubmit, projectHooks?.UserPromptSubmit),
  };
}
