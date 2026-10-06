import { readFileSync } from "node:fs";
import path from "node:path";
import { HOOK_EVENT_NAMES, type HooksConfig } from "../hooks/config.js";

// Managed (organization-level) settings: a file only an administrator can
// write (system directory), read at startup and enforced on top of whatever
// the user and the project configure. Everything here can only RESTRICT or
// ADD guardrails — nothing in it can grant a permission.
//
// Location: $FINANFA_MANAGED_SETTINGS if set (tests, containers), otherwise
//   macOS/Linux  /etc/finanfa-code/managed-settings.json
//   Windows      %ProgramData%\finanfa-code\managed-settings.json
export interface ManagedSettings {
  /** Hooks that always run, before any user, project or plugin hook. */
  hooks?: HooksConfig;
  /** When true, ONLY the managed hooks run: user, project and plugin hooks are ignored. */
  allowManagedHooksOnly?: boolean;
  /** When true, --yolo (auto-approve everything) is refused. */
  disableYolo?: boolean;
  /** When set, /plugin marketplace add accepts only these exact sources (an empty list forbids adding any). */
  strictKnownMarketplaces?: string[];
}

export function managedSettingsPath(): string {
  if (process.env.FINANFA_MANAGED_SETTINGS) return process.env.FINANFA_MANAGED_SETTINGS;
  if (process.platform === "win32") return path.join(process.env.ProgramData ?? "C:\\ProgramData", "finanfa-code", "managed-settings.json");
  return path.join("/etc", "finanfa-code", "managed-settings.json");
}

/**
 * If the file exists but can't be read or parsed, the policy fails CLOSED —
 * the strictest settings apply — rather than silently dropping the
 * restrictions an administrator meant to impose.
 */
const FAIL_CLOSED: ManagedSettings = { allowManagedHooksOnly: true, disableYolo: true, strictKnownMarketplaces: [] };

function parseManagedSettings(raw: string): ManagedSettings {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const settings: ManagedSettings = {};
  if (parsed.hooks && typeof parsed.hooks === "object") {
    const hooks: HooksConfig = {};
    for (const event of HOOK_EVENT_NAMES) {
      const matchers = (parsed.hooks as HooksConfig)[event];
      if (Array.isArray(matchers)) hooks[event] = matchers;
    }
    settings.hooks = hooks;
  }
  if (parsed.allowManagedHooksOnly === true) settings.allowManagedHooksOnly = true;
  if (parsed.disableYolo === true) settings.disableYolo = true;
  if (Array.isArray(parsed.strictKnownMarketplaces)) {
    settings.strictKnownMarketplaces = parsed.strictKnownMarketplaces.filter((s): s is string => typeof s === "string");
  }
  return settings;
}

let cached: { file: string; settings: ManagedSettings } | undefined;

/** Read once per process per file path (it is consulted on hot paths, and an administrator's file doesn't change mid-run). */
export function loadManagedSettings(): ManagedSettings {
  const file = managedSettingsPath();
  if (cached?.file === file) return cached.settings;
  let settings: ManagedSettings = {};
  try {
    settings = parseManagedSettings(readFileSync(file, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`Warning: managed settings at ${file} are unreadable (${err instanceof Error ? err.message : String(err)}) — applying the strictest policy.`);
      settings = FAIL_CLOSED;
    }
  }
  cached = { file, settings };
  return settings;
}

/** Test-only: forget the cached file so a test can point FINANFA_MANAGED_SETTINGS elsewhere. */
export function resetManagedSettingsCacheForTests(): void {
  cached = undefined;
}
