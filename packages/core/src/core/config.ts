import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { SandboxConfig } from "../util/sandbox.js";

export interface FinanfaConfig {
  provider?: "anthropic" | "openai-compatible" | "gemini" | "azure-openai" | "amazon-bedrock" | "google-vertex" | "cohere" | "github-copilot";
  /** For openai-compatible: the server's base URL. For azure-openai: the resource endpoint, e.g. "https://my-resource.openai.azure.com" (no trailing path) — same "where do I connect" role, reused rather than adding a second near-identical field. */
  baseUrl?: string;
  apiKey?: string;
  /** azure-openai only — defaults to a recent stable Azure OpenAI API version if unset. */
  azureApiVersion?: string;
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
  /** Only needed for an org-admin-scoped Anthropic API key (not scoped to a single workspace) — see AnthropicProvider's constructor comment. Can be left unset for a normal, already-workspace-scoped key. */
  anthropicWorkspaceId?: string;
  /** amazon-bedrock only — defaults to the AWS_REGION env var, then "us-east-1". Credentials come from the standard AWS credential chain, not from config. */
  awsRegion?: string;
  /** google-vertex only — defaults to the CLOUD_ML_REGION env var; no further fallback. */
  vertexRegion?: string;
  /** google-vertex only — the GCP project to bill/run against. Credentials come from Google Application Default Credentials, not from config. */
  vertexProjectId?: string;
  /** github-copilot only — a GitHub OAuth token with Copilot access, obtained via the device-authorization flow (see github-copilot-auth.ts and the README's GitHub Copilot setup section). Exchanged for a short-lived Copilot API token on every turn; never sent to api.githubcopilot.com directly. */
  githubCopilotToken?: string;
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
   * Enables Anthropic extended thinking (direct/Bedrock/Vertex — see
   * streamAnthropicTurn) with this token budget. A plain string like every
   * other /config-set value, parsed to a number where it's actually used
   * (session construction) — unset (the default) means no behavior
   * change, same as every other optional field here. Ignored entirely by
   * every non-Anthropic-family provider.
   */
  thinkingBudgetTokens?: string;
  /**
   * OS-level sandbox for the `bash` tool (bubblewrap on Linux — see
   * util/sandbox.ts). Unset/`{mode: "off"}`/bwrap unavailable all mean
   * unsandboxed (this project's original behavior). `{mode:
   * "workspace-write"}` confines writes to the command's cwd plus a
   * curated set of dev-tool cache dirs; the rest of the filesystem is
   * read-only, network stays shared.
   */
  sandbox?: SandboxConfig;
  /**
   * "auto" (default, unset also means this): Tool Search (see
   * tool-search.ts) turns on automatically when the resolved provider
   * looks local (see isLocalProviderConfig in app.ts), off otherwise.
   * "true"/"false" force it on/off regardless of provider — an explicit
   * choice always wins over the automatic one. A plain string, like
   * every other /config-set value (see thinkingBudgetTokens above) —
   * not a real boolean, so this stays a normal string-valued field for
   * the generic config plumbing (the web UI's /api/config, /config
   * show/set) that every other key here already assumes.
   */
  toolSearch?: "auto" | "true" | "false";

  /**
   * Same "auto"/"true"/"false" shape and precedence as toolSearch above.
   * "auto" (default) trims LOCAL_MODEL_LEAN_EXCLUDED_TOOLS (browser,
   * automations, image/video/audio generation, PDF conversion, messaging
   * channels — see local-model-lean.ts) whenever the provider looks
   * local, same heuristic as toolSearch. Real, reported motivation: a
   * comparable reference agent (OpenClaw) does this same trimming for
   * local models, on top of Tool Search reducing per-turn schema count —
   * Tool Search alone still lets a local model discover and attempt any
   * of these slow/credential-gated tools via search_tools.
   */
  localModelLean?: "auto" | "true" | "false";
  /**
   * Chat-channel credentials configured from the web UI's Channels panel
   * (see channel-catalog.ts), keyed by channel id then by the exact
   * environment variable name each field maps to — applied into
   * process.env by the web server at startup and on every save (see
   * channels-config-api.ts) so every existing channels-*.ts route, which
   * reads process.env directly, picks them up with no code changes and no
   * restart. A real environment variable already set in the shell that
   * started the server always wins over a value saved here.
   */
  channels?: Record<string, Record<string, string>>;
  /**
   * Path to a local .gguf model file — when set, ensureLocalTextModelServer
   * (core/local-model-manager.ts) uses it to auto-start a llama.cpp server
   * (or confirm one already running there is serving this exact model) so
   * the local-first default text model doesn't require the user to launch
   * llama-server by hand every time. Only meaningful alongside
   * provider: "openai-compatible"/TEXT_MODEL_PROVIDER pointed at a
   * localhost baseUrl — a remote or non-local provider ignores it.
   */
  textModelPath?: string;
  /** Overrides the "llama-server" binary name/path ensureLocalTextModelServer spawns — set this if it's not on PATH under its default name. */
  textModelBinary?: string;
  /** llama-server's -c/--ctx-size — defaults to 8192 if unset (see local-model-manager.ts). */
  textModelContextSize?: string;
}

/** Parses config.thinkingBudgetTokens (a plain string, like every other /config-set value) into the number session.thinkingBudgetTokens actually wants — undefined for unset/non-positive/non-numeric, never NaN or 0, so callers can assign it straight through without their own validation. */
export function thinkingBudgetTokensFromConfig(config: FinanfaConfig): number | undefined {
  if (!config.thinkingBudgetTokens) return undefined;
  const parsed = Number(config.thinkingBudgetTokens);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Resolves config.toolSearch against whether the provider actually looks local (isLocalProviderConfig in app.ts) into the plain boolean session.toolSearchEnabled wants — an explicit "true"/"false" always wins; "auto"/unset falls back to the local-provider heuristic. */
export function resolveToolSearchEnabled(config: FinanfaConfig, isLocalProvider: boolean): boolean {
  if (config.toolSearch === "true") return true;
  if (config.toolSearch === "false") return false;
  return isLocalProvider;
}

/** Resolves config.localModelLean the same way resolveToolSearchEnabled resolves config.toolSearch — an explicit "true"/"false" always wins; "auto"/unset falls back to the local-provider heuristic. */
export function resolveLocalModelLeanEnabled(config: FinanfaConfig, isLocalProvider: boolean): boolean {
  if (config.localModelLean === "true") return true;
  if (config.localModelLean === "false") return false;
  return isLocalProvider;
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
