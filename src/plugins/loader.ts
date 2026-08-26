import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolRegistry } from "../tools/registry.js";
import type { CommandRegistry } from "../commands/registry.js";

export interface PluginModule {
  registerTools?: (registry: ToolRegistry) => void | Promise<void>;
  registerCommands?: (commands: CommandRegistry) => void | Promise<void>;
}

/**
 * Loads every `.finanfa-code/plugins/<name>/index.js` in `cwd`, calling its
 * `registerTools`/`registerCommands` exports. A plugin that fails to load is
 * skipped (with a logged error) rather than crashing the whole session.
 */
export async function loadPlugins(
  cwd: string,
  tools: ToolRegistry,
  commands: CommandRegistry,
): Promise<string[]> {
  const dir = path.join(cwd, ".finanfa-code", "plugins");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const loaded: string[] = [];
  for (const entry of entries) {
    const entryFile = path.join(dir, entry, "index.js");
    try {
      const mod = (await import(pathToFileURL(entryFile).href)) as PluginModule;
      await mod.registerTools?.(tools);
      await mod.registerCommands?.(commands);
      loaded.push(entry);
    } catch (err) {
      console.error(`Failed to load plugin "${entry}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return loaded;
}
