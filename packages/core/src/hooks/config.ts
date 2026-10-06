import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadPluginHooks } from "../plugins/manager.js";

// Claude Code's own hooks feature: user- or project-configured shell
// commands that run at specific points in the agent loop (before a tool
// runs, after it runs, when the user submits a prompt) and can observe or
// influence what happens next. Config shape intentionally mirrors real
// Claude Code's hooks.json/settings.json `hooks` field so a user already
// familiar with that convention (matcher + array of {type: "command",
// command, timeout?}) can reuse the same mental model here.
export const HOOK_EVENT_NAMES = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "PreCompact",
] as const;
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export interface HookCommand {
  type: "command";
  command: string;
  /** Seconds. Defaults to 60 if omitted — see runner.ts. */
  timeout?: number;
}

export interface HookMatcher {
  /** Regex tested against the tool name (PreToolUse/PostToolUse only). Omitted matches every tool. Ignored for every other event. */
  matcher?: string;
  hooks: HookCommand[];
}

export type HooksConfig = { [E in HookEventName]?: HookMatcher[] };

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
  const pluginHooks = await loadPluginHooks(cwd, trusted);
  if (!globalHooks && !projectHooks && pluginHooks.length === 0) return EMPTY_HOOKS_CONFIG;

  // Order: the user's global hooks, then the project's, then plugins'. Hooks
  // run in this order and the first one to decide wins, so a plugin's hook
  // can never pre-empt (e.g. approve past) a hook the user wrote themselves.
  const merged: HooksConfig = {};
  for (const event of HOOK_EVENT_NAMES) {
    const fromPlugins = pluginHooks.flatMap((h) => h[event] ?? []);
    const entries = mergeEvent(mergeEvent(globalHooks?.[event], projectHooks?.[event]), fromPlugins.length > 0 ? fromPlugins : undefined);
    if (entries) merged[event] = entries;
  }
  return merged;
}
