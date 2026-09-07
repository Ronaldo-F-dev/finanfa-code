import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { SandboxConfig } from "../util/sandbox.js";

export interface FinanfaConfig {
  provider?: "anthropic" | "openai-compatible" | "gemini";
  baseUrl?: string;
  apiKey?: string;
  /**
   * A pool of API keys sharing the same baseUrl/model, tried in rotation
   * (see OpenAiCompatibleProvider) — for a community sharing one free-tier
   * model where any single member's key can be rate-limited or run dry.
   * Takes priority over `apiKey` when non-empty; `apiKey` stays as the
   * simple single-key path for everyone else.
   */
  apiKeys?: string[];
  model?: string;
  /**
   * A Claude API key stored independently of `provider`/`apiKey` — those two
   * are scoped to whichever single provider is "active" (set by /config or
   * the CLI), so saving an Anthropic key there while a different provider is
   * active would silently not apply. This field exists so a frontend (the
   * web UI) can let someone add a Claude key without disturbing whatever
   * else is already configured, and switch to a Claude model mid-session
   * without first reconfiguring the whole active provider.
   */
  anthropicApiKey?: string;
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
  /**
   * OS-level sandbox for the `bash` tool (bubblewrap on Linux — see
   * util/sandbox.ts). Unset/`{mode: "off"}`/bwrap unavailable all mean
   * unsandboxed (this project's original behavior). `{mode:
   * "workspace-write"}` confines writes to the command's cwd plus a
   * curated set of dev-tool cache dirs; the rest of the filesystem is
   * read-only, network stays shared.
   */
  sandbox?: SandboxConfig;
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
