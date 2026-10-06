import path from "node:path";
import { loadCustomCommands } from "./custom-commands.js";
import { loadHooksConfig } from "../hooks/config.js";
import { isTrustedWithoutPrompt } from "../core/trust-gate.js";
import {
  addMarketplace,
  discoverPlugins,
  installPlugin,
  listMarketplaces,
  removeMarketplace,
  removePlugin,
  searchMarketplaces,
  setPluginEnabled,
  updateMarketplace,
  validatePlugin,
} from "../plugins/manager.js";
import type { CommandContext, CommandOutcome } from "./types.js";

const USAGE = [
  "Usage:",
  "  /plugin list                              installed plugins",
  "  /plugin search [text]                     plugins offered by registered marketplaces",
  "  /plugin install <plugin>[@<marketplace>]  install from a marketplace",
  "  /plugin remove <plugin>                   uninstall",
  "  /plugin enable|disable <plugin>",
  "  /plugin test <directory>                  validate a plugin folder",
  "  /plugin reload                            re-read hooks and slash commands now",
  "  /plugin marketplace add <git-url|dir>     register a marketplace",
  "  /plugin marketplace list|update <name>|remove <name>",
].join("\n");

const RESTART_NOTE = "Plugin slash commands and hooks are active now; plugin subagent types and skills need a restart.";

/**
 * Re-reads hooks (user, project and plugin) and slash commands in place, so a
 * plugin change shows up without restarting. Subagent types and skills are
 * bound at startup (the task tool and the system prompt capture them), so
 * those still need a restart — the caller says so via RESTART_NOTE.
 */
async function reloadPluginContent(ctx: CommandContext): Promise<string> {
  const trusted = await isTrustedWithoutPrompt(ctx.cwd);
  const hooks = await loadHooksConfig(ctx.cwd, trusted);
  ctx.permissions.setHooksConfig(hooks);
  const hookCount = Object.values(hooks).reduce((n, matchers) => n + (matchers ?? []).reduce((m, x) => m + x.hooks.length, 0), 0);

  let commandNote = "";
  if (ctx.customCommands) {
    const fresh = await loadCustomCommands(ctx.cwd);
    ctx.customCommands.clear();
    for (const [name, command] of fresh) ctx.customCommands.set(name, command);
    if (ctx.commands) {
      const builtin = ctx.commands;
      ctx.ui.setCommands([
        ...builtin.list(),
        ...[...fresh.values()].filter((c) => !builtin.get(c.name)).map((c) => ({ name: c.name, description: c.description })),
      ]);
    }
    commandNote = `, ${fresh.size} custom command(s)`;
  }
  return `${hookCount} hook(s)${commandNote}`;
}

async function handleMarketplace(ctx: CommandContext, words: string[]): Promise<void> {
  const [action, ...rest] = words;
  const arg = rest.join(" ").trim();
  if (action === "add") {
    if (!arg) return ctx.ui.writeError("Usage: /plugin marketplace add <git-url|directory>");
    const market = await addMarketplace(arg);
    return ctx.ui.writeSystem(`Added marketplace "${market.name}" (${market.plugins.length} plugin(s)). Browse it with /plugin search.`);
  }
  if (action === "list" || !action) {
    const markets = await listMarketplaces();
    return ctx.ui.writeSystem(markets.length === 0 ? "No marketplaces registered. Add one with /plugin marketplace add <git-url|dir>." : markets.map((m) => `${m.name} — ${m.pluginCount} plugin(s) — ${m.source}`).join("\n"));
  }
  if (action === "update") {
    if (!arg) return ctx.ui.writeError("Usage: /plugin marketplace update <name>");
    const market = await updateMarketplace(arg);
    return ctx.ui.writeSystem(`Updated marketplace "${market.name}" (${market.plugins.length} plugin(s)).`);
  }
  if (action === "remove") {
    if (!arg) return ctx.ui.writeError("Usage: /plugin marketplace remove <name>");
    return (await removeMarketplace(arg)) ? ctx.ui.writeSystem(`Removed marketplace "${arg}". Plugins already installed from it stay installed.`) : ctx.ui.writeError(`No marketplace named "${arg}".`);
  }
  ctx.ui.writeError(USAGE);
}

async function dispatch(ctx: CommandContext): Promise<void> {
  const [sub, ...rest] = ctx.args.trim().split(/\s+/).filter(Boolean);
  const arg = rest.join(" ");

  switch (sub) {
    case undefined:
    case "list": {
      const plugins = await discoverPlugins(ctx.cwd);
      if (plugins.length === 0) return ctx.ui.writeSystem("No plugins installed. Try /plugin marketplace add <git-url|dir>, then /plugin search.");
      return ctx.ui.writeSystem(
        plugins.map((p) => `${p.name}${p.manifest.version ? `@${p.manifest.version}` : ""} [${p.scope}${p.enabled ? "" : ", disabled"}]${p.manifest.description ? ` — ${p.manifest.description}` : ""}`).join("\n"),
      );
    }
    case "search": {
      const found = await searchMarketplaces(arg);
      return ctx.ui.writeSystem(found.length === 0 ? "No matching plugins (register a marketplace with /plugin marketplace add)." : found.map((f) => `${f.name}@${f.marketplace}${f.description ? ` — ${f.description}` : ""}`).join("\n"));
    }
    case "install": {
      if (!arg) return ctx.ui.writeError("Usage: /plugin install <plugin>[@<marketplace>]");
      const plugin = await installPlugin(arg);
      const loaded = await reloadPluginContent(ctx);
      return ctx.ui.writeSystem(`Installed "${plugin.name}". Review what it ships (hooks run shell commands) in ${plugin.dir}. Reloaded: ${loaded}. ${RESTART_NOTE}`);
    }
    case "remove":
    case "uninstall": {
      if (!arg) return ctx.ui.writeError("Usage: /plugin remove <plugin>");
      if (!(await removePlugin(arg))) {
        return ctx.ui.writeError(`No installed plugin named "${arg}" (project plugins are removed by deleting their folder).`);
      }
      return ctx.ui.writeSystem(`Removed "${arg}". Reloaded: ${await reloadPluginContent(ctx)}. ${RESTART_NOTE}`);
    }
    case "enable":
    case "disable": {
      if (!arg) return ctx.ui.writeError(`Usage: /plugin ${sub} <plugin>`);
      if (!(await setPluginEnabled(arg, sub === "enable", ctx.cwd))) return ctx.ui.writeError(`No plugin named "${arg}" — see /plugin list.`);
      return ctx.ui.writeSystem(`${sub === "enable" ? "Enabled" : "Disabled"} "${arg}". Reloaded: ${await reloadPluginContent(ctx)}. ${RESTART_NOTE}`);
    }
    case "reload":
      return ctx.ui.writeSystem(`Reloaded: ${await reloadPluginContent(ctx)}. ${RESTART_NOTE}`);
    case "test": {
      if (!arg) return ctx.ui.writeError("Usage: /plugin test <directory>");
      const dir = path.resolve(ctx.cwd, arg);
      const issues = await validatePlugin(dir);
      return issues.length === 0 ? ctx.ui.writeSystem(`${dir} looks like a valid plugin.`) : ctx.ui.writeError(`${issues.length} problem(s) in ${dir}:\n  ${issues.join("\n  ")}`);
    }
    case "marketplace":
      return handleMarketplace(ctx, rest);
    default:
      return ctx.ui.writeError(USAGE);
  }
}

export async function handlePlugin(ctx: CommandContext): Promise<CommandOutcome> {
  try {
    await dispatch(ctx);
  } catch (err) {
    ctx.ui.writeError(err instanceof Error ? err.message : String(err));
  }
  return "continue";
}
