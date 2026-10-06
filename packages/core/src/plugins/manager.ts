import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import matter from "gray-matter";
import { HOOK_EVENT_NAMES, type HooksConfig } from "../hooks/config.js";
import { loadManagedSettings } from "../core/managed-settings.js";

const execFileAsync = promisify(execFile);

// Directory-format plugins. A plugin is a folder holding any mix of:
//   plugin.json          optional manifest: { name, version?, description? }
//   commands/*.md        slash commands (same format as .finanfa-code/commands)
//   agents/*.md          subagent types (same format as .finanfa-code/agents)
//   skills/*.md          skills (same format as .finanfa-code/skills)
//   hooks/hooks.json     { "hooks": { <event>: [{ matcher?, hooks: [...] }] } }
//   index.js             optional code plugin (see loader.ts) — project-level only
// Installed plugins live in ~/.finanfa-code/plugins/<name>/; a project can also
// carry its own under .finanfa-code/plugins/<name>/. Marketplaces are catalogs
// (a marketplace.json) that tell /plugin install where to fetch a plugin from.

export type PluginScope = "global" | "project";

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
}

export interface PluginInfo {
  name: string;
  dir: string;
  scope: PluginScope;
  manifest: PluginManifest;
  enabled: boolean;
}

export type MarketplaceSource = string | { source: "git"; url: string } | { source: "path"; path: string };

export interface MarketplacePluginEntry {
  name: string;
  description?: string;
  version?: string;
  /** A path relative to the marketplace root, or an explicit git/path source. */
  source: MarketplaceSource;
}

export interface Marketplace {
  name: string;
  description?: string;
  plugins: MarketplacePluginEntry[];
}

interface MarketplaceRecord {
  /** What the user typed to add it (a git URL or a local directory). */
  source: string;
  /** Where its files live on disk (a clone under ~/.finanfa-code/marketplaces, or the local directory itself). */
  dir: string;
}

interface PluginState {
  marketplaces: Record<string, MarketplaceRecord>;
  disabled: string[];
}

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PLUGIN_ROOT_VAR = "${FINANFA_PLUGIN_ROOT}";

// Computed per call, never memoized — a test overriding $HOME must see it.
export function globalPluginsDir(): string {
  return path.join(os.homedir(), ".finanfa-code", "plugins");
}

export function projectPluginsDir(cwd: string): string {
  return path.join(cwd, ".finanfa-code", "plugins");
}

function marketplacesDir(): string {
  return path.join(os.homedir(), ".finanfa-code", "marketplaces");
}

function pluginStatePath(): string {
  return path.join(os.homedir(), ".finanfa-code", "plugins.json");
}

async function loadState(): Promise<PluginState> {
  try {
    const parsed = JSON.parse(await readFile(pluginStatePath(), "utf-8")) as Partial<PluginState>;
    return { marketplaces: parsed.marketplaces ?? {}, disabled: parsed.disabled ?? [] };
  } catch {
    return { marketplaces: {}, disabled: [] };
  }
}

async function saveState(state: PluginState): Promise<void> {
  await mkdir(path.dirname(pluginStatePath()), { recursive: true });
  await writeFile(pluginStatePath(), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readManifest(dir: string, fallbackName: string): Promise<PluginManifest> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf-8")) as Partial<PluginManifest>;
    return { name: typeof parsed.name === "string" && parsed.name ? parsed.name : fallbackName, version: parsed.version, description: parsed.description };
  } catch {
    return { name: fallbackName };
  }
}

async function scanPluginsDir(dir: string, scope: PluginScope, disabled: Set<string>): Promise<PluginInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const plugins: PluginInfo[] = [];
  for (const entry of entries.sort()) {
    const pluginDir = path.join(dir, entry);
    if (!(await isDirectory(pluginDir))) continue;
    const manifest = await readManifest(pluginDir, entry);
    plugins.push({ name: entry, dir: pluginDir, scope, manifest, enabled: !disabled.has(entry) });
  }
  return plugins;
}

/** Every plugin folder found (installed globally or carried by the project), enabled or not. */
export async function discoverPlugins(cwd: string): Promise<PluginInfo[]> {
  const state = await loadState();
  const disabled = new Set(state.disabled);
  const [global, project] = await Promise.all([scanPluginsDir(globalPluginsDir(), "global", disabled), scanPluginsDir(projectPluginsDir(cwd), "project", disabled)]);
  return [...global, ...project];
}

/**
 * The `<plugin>/<kind>` directories of every enabled plugin, lowest-precedence
 * first — loaders put them ahead of the user's own global/project dirs so a
 * user's own file always wins a name collision with a plugin's.
 */
export async function pluginContentDirs(cwd: string, kind: "commands" | "agents" | "skills"): Promise<string[]> {
  const plugins = await discoverPlugins(cwd);
  return plugins.filter((p) => p.enabled).map((p) => path.join(p.dir, kind));
}

/** Resolves ${FINANFA_PLUGIN_ROOT} inside hook commands to the plugin's own directory, so a hook can ship and call its own scripts. */
function expandPluginRoot(config: HooksConfig, root: string): HooksConfig {
  const out: HooksConfig = {};
  for (const event of HOOK_EVENT_NAMES) {
    const matchers = config[event];
    if (!matchers) continue;
    out[event] = matchers.map((m) => ({ ...m, hooks: m.hooks.map((h) => (h.type === "command" ? { ...h, command: h.command.replaceAll(PLUGIN_ROOT_VAR, root) } : h)) }));
  }
  return out;
}

/**
 * Hooks contributed by enabled plugins. A project-carried plugin's hooks are
 * only honored when the project is trusted — same gate as the project's own
 * settings.json hooks (see hooks/config.ts), since a hook is shell execution.
 */
export async function loadPluginHooks(cwd: string, trusted: boolean): Promise<HooksConfig[]> {
  const plugins = await discoverPlugins(cwd);
  const configs: HooksConfig[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    if (plugin.scope === "project" && !trusted) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(plugin.dir, "hooks", "hooks.json"), "utf-8")) as { hooks?: HooksConfig };
      if (parsed.hooks) configs.push(expandPluginRoot(parsed.hooks, plugin.dir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error(`Warning: failed to read hooks of plugin "${plugin.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return configs;
}

// --- validation (/plugin test) -------------------------------------------

/** Checks a plugin folder's structure and returns human-readable problems; an empty list means it looks valid. */
export async function validatePlugin(dir: string): Promise<string[]> {
  const issues: string[] = [];
  if (!(await isDirectory(dir))) return [`${dir} is not a directory`];

  try {
    const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf-8")) as Partial<PluginManifest>;
    if (typeof manifest.name !== "string" || !SAFE_NAME.test(manifest.name)) issues.push('plugin.json: "name" must be a string of letters, digits, ".", "_" or "-"');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") issues.push(`plugin.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  let contributes = false;
  for (const kind of ["commands", "agents", "skills"] as const) {
    let files: string[] = [];
    try {
      files = (await readdir(path.join(dir, kind))).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      contributes = true;
      try {
        const { data, content } = matter(await readFile(path.join(dir, kind, file), "utf-8"));
        if (!content.trim()) issues.push(`${kind}/${file}: empty body`);
        if (kind !== "commands" && typeof data.description !== "string") issues.push(`${kind}/${file}: missing "description" in frontmatter`);
      } catch (err) {
        issues.push(`${kind}/${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  try {
    const parsed = JSON.parse(await readFile(path.join(dir, "hooks", "hooks.json"), "utf-8")) as { hooks?: Record<string, unknown> };
    contributes = true;
    for (const event of Object.keys(parsed.hooks ?? {})) {
      if (!(HOOK_EVENT_NAMES as readonly string[]).includes(event)) issues.push(`hooks/hooks.json: unknown event "${event}"`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") issues.push(`hooks/hooks.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!contributes) {
    try {
      await stat(path.join(dir, "index.js"));
    } catch {
      issues.push("the plugin contributes nothing (no commands/, agents/, skills/, hooks/hooks.json or index.js)");
    }
  }
  return issues;
}

// --- marketplaces ---------------------------------------------------------

function looksLikeGitUrl(source: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@)/.test(source) || source.endsWith(".git");
}

async function gitClone(url: string, dest: string): Promise<void> {
  // "--" keeps a URL that starts with "-" from being parsed as a git option.
  await execFileAsync("git", ["clone", "--depth", "1", "--", url, dest], { timeout: 120_000 });
}

async function readMarketplaceFile(root: string): Promise<Marketplace> {
  for (const candidate of [path.join(root, "marketplace.json"), path.join(root, ".claude-plugin", "marketplace.json")]) {
    let raw: string;
    try {
      raw = await readFile(candidate, "utf-8");
    } catch {
      continue;
    }
    const parsed = JSON.parse(raw) as Partial<Marketplace>;
    if (typeof parsed.name !== "string" || !SAFE_NAME.test(parsed.name)) throw new Error(`${candidate}: "name" is missing or has unsafe characters`);
    if (!Array.isArray(parsed.plugins)) throw new Error(`${candidate}: "plugins" must be an array`);
    const plugins = parsed.plugins.filter((p): p is MarketplacePluginEntry => Boolean(p) && typeof p.name === "string" && SAFE_NAME.test(p.name) && p.source !== undefined);
    return { name: parsed.name, description: parsed.description, plugins };
  }
  throw new Error(`no marketplace.json found in ${root}`);
}

/** Registers a marketplace from a git URL (cloned locally) or a local directory (read in place). */
export async function addMarketplace(source: string): Promise<Marketplace> {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("a marketplace source (git URL or directory) is required");
  const allowed = loadManagedSettings().strictKnownMarketplaces;
  if (allowed && !allowed.includes(trimmed)) {
    throw new Error(allowed.length === 0 ? "managed settings forbid adding marketplaces" : `managed settings only allow these marketplaces: ${allowed.join(", ")}`);
  }

  let dir: string;
  let cloned = false;
  if (looksLikeGitUrl(trimmed)) {
    await mkdir(marketplacesDir(), { recursive: true });
    dir = path.join(marketplacesDir(), `.pending-${Date.now()}`);
    await gitClone(trimmed, dir);
    cloned = true;
  } else {
    dir = path.resolve(trimmed);
    if (!(await isDirectory(dir))) throw new Error(`${dir} is not a directory`);
  }

  let marketplace: Marketplace;
  try {
    marketplace = await readMarketplaceFile(dir);
  } catch (err) {
    if (cloned) await rm(dir, { recursive: true, force: true });
    throw err;
  }

  if (cloned) {
    const final = path.join(marketplacesDir(), marketplace.name);
    await rm(final, { recursive: true, force: true });
    await cp(dir, final, { recursive: true });
    await rm(dir, { recursive: true, force: true });
    dir = final;
  }

  const state = await loadState();
  state.marketplaces[marketplace.name] = { source: trimmed, dir };
  await saveState(state);
  return marketplace;
}

export async function listMarketplaces(): Promise<Array<{ name: string; source: string; pluginCount: number }>> {
  const state = await loadState();
  const result: Array<{ name: string; source: string; pluginCount: number }> = [];
  for (const [name, record] of Object.entries(state.marketplaces)) {
    try {
      result.push({ name, source: record.source, pluginCount: (await readMarketplaceFile(record.dir)).plugins.length });
    } catch {
      result.push({ name, source: record.source, pluginCount: 0 });
    }
  }
  return result;
}

export async function removeMarketplace(name: string): Promise<boolean> {
  const state = await loadState();
  const record = state.marketplaces[name];
  if (!record) return false;
  delete state.marketplaces[name];
  await saveState(state);
  // Only a clone this module made is ours to delete — never a user's local directory.
  if (record.dir.startsWith(marketplacesDir() + path.sep)) await rm(record.dir, { recursive: true, force: true });
  return true;
}

/** Re-pulls a git marketplace (a local-directory one is read live, so there is nothing to refresh). */
export async function updateMarketplace(name: string): Promise<Marketplace> {
  const state = await loadState();
  const record = state.marketplaces[name];
  if (!record) throw new Error(`no marketplace named "${name}" — see /plugin marketplace list`);
  if (looksLikeGitUrl(record.source)) return addMarketplace(record.source);
  return readMarketplaceFile(record.dir);
}

/** Every plugin offered by every registered marketplace. */
export async function searchMarketplaces(query = ""): Promise<Array<MarketplacePluginEntry & { marketplace: string }>> {
  const state = await loadState();
  const needle = query.toLowerCase();
  const found: Array<MarketplacePluginEntry & { marketplace: string }> = [];
  for (const [name, record] of Object.entries(state.marketplaces)) {
    try {
      for (const entry of (await readMarketplaceFile(record.dir)).plugins) {
        if (!needle || entry.name.toLowerCase().includes(needle) || (entry.description ?? "").toLowerCase().includes(needle)) found.push({ ...entry, marketplace: name });
      }
    } catch {
      // a marketplace whose file went missing just contributes nothing
    }
  }
  return found;
}

// --- install / remove / enable -------------------------------------------

/** Installs `<plugin>@<marketplace>` (or just `<plugin>` when exactly one marketplace offers it) into ~/.finanfa-code/plugins. */
export async function installPlugin(spec: string): Promise<PluginInfo> {
  const [pluginName, marketName] = spec.trim().split("@");
  if (!pluginName || !SAFE_NAME.test(pluginName)) throw new Error("usage: /plugin install <plugin>[@<marketplace>]");

  const state = await loadState();
  const candidates: Array<{ record: MarketplaceRecord; entry: MarketplacePluginEntry }> = [];
  for (const [name, record] of Object.entries(state.marketplaces)) {
    if (marketName && name !== marketName) continue;
    try {
      const entry = (await readMarketplaceFile(record.dir)).plugins.find((p) => p.name === pluginName);
      if (entry) candidates.push({ record, entry });
    } catch {
      // unreadable marketplace — skip it
    }
  }
  if (candidates.length === 0) throw new Error(`no plugin "${pluginName}"${marketName ? ` in marketplace "${marketName}"` : " in any registered marketplace"} — see /plugin search`);
  if (candidates.length > 1) throw new Error(`"${pluginName}" is offered by several marketplaces — use ${pluginName}@<marketplace>`);

  const { record, entry } = candidates[0];
  const dest = path.join(globalPluginsDir(), pluginName);
  if (await isDirectory(dest)) throw new Error(`"${pluginName}" is already installed — /plugin remove ${pluginName} first to reinstall`);

  await mkdir(globalPluginsDir(), { recursive: true });
  const source = entry.source;
  const gitUrl = typeof source === "object" && source.source === "git" ? source.url : typeof source === "string" && looksLikeGitUrl(source) ? source : undefined;
  if (gitUrl) {
    await gitClone(gitUrl, dest);
    await rm(path.join(dest, ".git"), { recursive: true, force: true });
  } else {
    const relative = typeof source === "string" ? source : source.source === "path" ? source.path : "";
    const from = path.resolve(record.dir, relative);
    // A catalog entry must not reach outside its own marketplace directory.
    if (from !== record.dir && !from.startsWith(record.dir + path.sep)) throw new Error(`plugin "${pluginName}" points outside its marketplace`);
    if (!(await isDirectory(from))) throw new Error(`plugin "${pluginName}": ${from} is not a directory`);
    await cp(from, dest, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
  }

  const issues = await validatePlugin(dest);
  if (issues.length > 0) {
    await rm(dest, { recursive: true, force: true });
    throw new Error(`"${pluginName}" is not a valid plugin:\n  ${issues.join("\n  ")}`);
  }
  return { name: pluginName, dir: dest, scope: "global", manifest: await readManifest(dest, pluginName), enabled: true };
}

export async function removePlugin(name: string): Promise<boolean> {
  if (!SAFE_NAME.test(name)) return false;
  const dir = path.join(globalPluginsDir(), name);
  if (!(await isDirectory(dir))) return false;
  await rm(dir, { recursive: true, force: true });
  const state = await loadState();
  state.disabled = state.disabled.filter((n) => n !== name);
  await saveState(state);
  return true;
}

export async function setPluginEnabled(name: string, enabled: boolean, cwd: string): Promise<boolean> {
  const plugins = await discoverPlugins(cwd);
  if (!plugins.some((p) => p.name === name)) return false;
  const state = await loadState();
  const disabled = new Set(state.disabled);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  state.disabled = [...disabled];
  await saveState(state);
  return true;
}
