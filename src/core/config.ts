import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface FinanfaConfig {
  provider?: "anthropic" | "openai-compatible";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /**
   * A second, vision-capable model used only for the follow-up turn right
   * after a tool (browser_screenshot, view_image) returns an image — the
   * primary model/provider is often chosen for cost/availability and may not
   * support image input at all (e.g. poolside/laguna-s-2.1 is text-only).
   * Unset by default: no routing, everything uses the primary model.
   */
  visionProvider?: "anthropic" | "openai-compatible";
  visionBaseUrl?: string;
  visionApiKey?: string;
  visionModel?: string;
}

// Computed lazily (not memoized as a module constant) so it reflects the
// current $HOME/os.homedir() at call time rather than whatever it was when
// this module first loaded — matters for tests that override $HOME.
export function globalConfigPath(): string {
  return path.join(os.homedir(), ".finanfa-code", "config.json");
}

function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".finanfa-code", "config.json");
}

async function readJsonIfExists(file: string): Promise<Partial<FinanfaConfig> | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as Partial<FinanfaConfig>;
  } catch (err) {
    // A missing file is normal and silent. Anything else (malformed JSON, a
    // permission error) used to look identical — silently falling back to
    // defaults with no diagnostic, so a typo'd config file just quietly
    // stopped applying with nothing pointing at why.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`Warning: failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  }
}

/**
 * Merges the global config (~/.finanfa-code/config.json, applies everywhere)
 * with a project-local one (<cwd>/.finanfa-code/config.json, takes priority)
 * — a persistent default for provider/model/apiKey so you don't have to
 * re-export the same environment variables every session. Environment
 * variables and CLI flags still take priority over both (see cli.ts).
 */
export async function loadConfig(cwd: string): Promise<FinanfaConfig> {
  const [global, project] = await Promise.all([
    readJsonIfExists(globalConfigPath()),
    readJsonIfExists(projectConfigPath(cwd)),
  ]);
  return { ...global, ...project };
}

/**
 * Persists to the global config file. Restricted to owner read/write (chmod
 * 600) since it may hold an API key in plain text — same trust level as an
 * SSH key or .netrc, not meant to be shared or committed.
 */
export async function saveGlobalConfig(config: FinanfaConfig): Promise<void> {
  const file = globalConfigPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2), "utf-8");
  await chmod(file, 0o600);
}
