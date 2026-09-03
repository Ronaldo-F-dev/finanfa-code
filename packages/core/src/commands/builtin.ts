import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { AgentSession } from "../core/session.js";
import { loadMcpServers, type McpServerConfig } from "../mcp/config.js";
import { MCP_TOOL_PREFIX } from "../mcp/client-manager.js";
import { loadConfig, saveGlobalConfig, globalConfigPath, type FinanfaConfig } from "../core/config.js";
import { loadMemories } from "../memory/loader.js";
import type { CommandContext, CommandOutcome } from "./types.js";
import type { CommandRegistry } from "./registry.js";

async function reloadMcpTools(ctx: CommandContext): Promise<void> {
  ctx.tools.unregisterByPrefix(MCP_TOOL_PREFIX);
  const definitions = await ctx.mcp.listAllTools();
  for (const def of definitions) ctx.tools.register(def);
}

function handleMcpEnableDisable(ctx: CommandContext, enable: boolean, name: string | undefined): CommandOutcome {
  if (!name) {
    ctx.ui.writeError(`Usage: /mcp ${enable ? "enable" : "disable"} <name>`);
    return "continue";
  }
  if (!ctx.mcp.connectedServers().includes(name)) {
    ctx.ui.writeError(`No connected MCP server named "${name}".`);
    return "continue";
  }
  if (enable) ctx.session.disabledMcpServers.delete(name);
  else ctx.session.disabledMcpServers.add(name);
  ctx.ui.writeSystem(
    enable
      ? `"${name}" tools will be offered to the model again.`
      : `"${name}" stays connected, but its tools won't be offered to the model until re-enabled.`,
  );
  return "continue";
}

async function handleMcp(ctx: CommandContext): Promise<CommandOutcome> {
  const [sub, ...rest] = ctx.args.trim().split(/\s+/);

  if (sub === "list") {
    const connected = ctx.mcp.connectedServers();
    if (connected.length === 0) {
      ctx.ui.writeSystem("No MCP servers connected.");
      return "continue";
    }
    ctx.ui.writeSystem(
      connected
        .map((name) => `${name}${ctx.session.disabledMcpServers.has(name) ? " (disabled)" : ""}`)
        .join(", "),
    );
    return "continue";
  }

  if (sub === "reload") {
    await reloadMcpTools(ctx);
    ctx.ui.writeSystem("MCP tools reloaded.");
    return "continue";
  }

  if (sub === "add") {
    return addMcpServer(ctx, rest);
  }

  if (sub === "connect") return connectMcpServer(ctx, rest[0]);

  if (sub === "enable") return handleMcpEnableDisable(ctx, true, rest[0]);
  if (sub === "disable") return handleMcpEnableDisable(ctx, false, rest[0]);

  ctx.ui.writeError(
    "Usage: /mcp list | /mcp reload | /mcp add <name> -- <command> [args...] | /mcp add <name> --url <url> " +
      "[--transport sse] | /mcp connect <name> | /mcp enable <name> | /mcp disable <name>",
  );
  return "continue";
}

/** For a server that was skipped at startup (no saved token yet, see connectMcpServers's allowOAuthPrompt: false) — explicit user action gets the full interactive OAuth flow. */
async function connectMcpServer(ctx: CommandContext, name: string | undefined): Promise<CommandOutcome> {
  if (!name) {
    ctx.ui.writeError("Usage: /mcp connect <name>");
    return "continue";
  }
  const servers = await loadMcpServers(ctx.cwd);
  const config = servers.find((s) => s.name === name);
  if (!config) {
    ctx.ui.writeError(`No MCP server named "${name}" in .finanfa-code/mcp.json.`);
    return "continue";
  }
  if (ctx.mcp.connectedServers().includes(name)) {
    ctx.ui.writeSystem(`"${name}" is already connected.`);
    return "continue";
  }

  if (config.transport !== "stdio") {
    ctx.ui.writeSystem(`Connecting to "${name}" — if it requires authorization, a browser tab will open...`);
  }
  try {
    await ctx.mcp.connect(config);
  } catch (err) {
    ctx.ui.writeError(`Failed to connect "${name}": ${err instanceof Error ? err.message : err}`);
    return "continue";
  }
  await reloadMcpTools(ctx);
  ctx.ui.writeSystem(`Connected "${name}".`);
  return "continue";
}

async function addMcpServer(ctx: CommandContext, rest: string[]): Promise<CommandOutcome> {
  const joined = rest.join(" ");
  const namePart = rest[0];
  const config = namePart ? parseMcpAddArgs(namePart, joined.slice(namePart.length).trim()) : undefined;

  if (!namePart || !config) {
    ctx.ui.writeError(
      "Usage: /mcp add <name> -- <command> [args...]  |  /mcp add <name> --url <url> [--transport sse]",
    );
    return "continue";
  }

  const file = path.join(ctx.cwd, ".finanfa-code", "mcp.json");
  const existing = await loadMcpServers(ctx.cwd);
  const next: McpServerConfig[] = [...existing.filter((s) => s.name !== namePart), config];
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ servers: next }, null, 2), "utf-8");

  if (config.transport !== "stdio") {
    ctx.ui.writeSystem(`Connecting to "${namePart}" — if it requires authorization, a browser tab will open...`);
  }
  await ctx.mcp.connect(config);
  await reloadMcpTools(ctx);
  ctx.ui.writeSystem(`Added and connected MCP server "${namePart}".`);
  return "continue";
}

function parseMcpAddArgs(name: string, rest: string): McpServerConfig | undefined {
  const urlMatch = rest.match(/--url\s+(\S+)/);
  if (urlMatch) {
    const transportMatch = rest.match(/--transport\s+(\S+)/);
    const transport = transportMatch?.[1] === "sse" ? "sse" : "http";
    return { name, transport, url: urlMatch[1] };
  }

  // Fall back to the stdio form: /mcp add <name> -- <command> [args...]
  const dashDashIndex = rest.indexOf("--");
  if (dashDashIndex === -1) return undefined;
  const commandPart = rest.slice(dashDashIndex + 2).trim();
  if (!commandPart) return undefined;
  const [command, ...args] = commandPart.split(/\s+/);
  return { name, transport: "stdio", command, args };
}

async function handleUndo(ctx: CommandContext): Promise<CommandOutcome> {
  const record = ctx.session.history.pop();
  if (!record) {
    ctx.ui.writeSystem("Nothing to undo.");
    return "continue";
  }

  const relative = path.relative(ctx.cwd, record.path);
  if (record.before === undefined) {
    await rm(record.path, { force: true });
    ctx.ui.writeSystem(`Undone: deleted ${relative} (it didn't exist before that change).`);
  } else {
    await mkdir(path.dirname(record.path), { recursive: true });
    await writeFile(record.path, record.before, "utf-8");
    ctx.ui.writeSystem(`Undone: restored ${relative} to its previous content.`);
  }
  return "continue";
}

function handleTodos(ctx: CommandContext): CommandOutcome {
  ctx.ui.writeSystem(ctx.session.todos.format());
  return "continue";
}

async function handleMemory(ctx: CommandContext): Promise<CommandOutcome> {
  const memories = await loadMemories(ctx.cwd);
  if (memories.length === 0) {
    ctx.ui.writeSystem("No memories saved for this project yet.");
    return "continue";
  }
  ctx.ui.writeSystem(memories.map((m) => `${m.name} (${m.type}): ${m.description}`).join("\n"));
  return "continue";
}

async function handleSessions(ctx: CommandContext): Promise<CommandOutcome> {
  const [sub, id] = ctx.args.trim().split(/\s+/);

  if (sub === "delete" && id === "all") {
    const sessions = await AgentSession.list(ctx.cwd);
    const toDelete = sessions.filter((s) => s.id !== ctx.session.id);
    await Promise.all(toDelete.map((s) => AgentSession.delete(ctx.cwd, s.id)));
    ctx.ui.writeSystem(
      toDelete.length > 0
        ? `Deleted ${toDelete.length} session(s) for this directory (kept the current one — it's still active).`
        : "No other saved sessions to delete.",
    );
    return "continue";
  }

  if (sub === "delete" && id) {
    if (id === ctx.session.id) {
      ctx.ui.writeError(
        "Can't delete the current session while it's active — it would just get recreated on the next save. " +
          "/exit first, then delete it from a different session.",
      );
      return "continue";
    }
    await AgentSession.delete(ctx.cwd, id);
    ctx.ui.writeSystem(`Deleted session ${id}.`);
    return "continue";
  }

  if (sub === "delete") {
    ctx.ui.writeError("Usage: /sessions delete <id> | /sessions delete all");
    return "continue";
  }

  // An unrecognized subcommand (typo, e.g. "deletee") must not silently fall
  // through to a plain listing — that reads as "my command did nothing" or,
  // worse, as if it had actually done what was typed.
  if (sub) {
    ctx.ui.writeError(`Unknown "/sessions ${sub}". Usage: /sessions | /sessions delete <id> | /sessions delete all`);
    return "continue";
  }

  const sessions = await AgentSession.list(ctx.cwd);
  if (sessions.length === 0) {
    ctx.ui.writeSystem("No saved sessions for this directory.");
    return "continue";
  }
  ctx.ui.writeSystem(
    sessions
      .map((s) => {
        const label = s.title ? `"${s.title}" — ${s.id}` : s.id;
        return `${label}${s.id === ctx.session.id ? " (current)" : ""} — ${s.mtime.toISOString()}`;
      })
      .join("\n"),
  );
  return "continue";
}

/** Switches the REPL's active session to a different saved one, e.g. `/session <id>` from an id shown by /sessions. Persists the outgoing session first, so nothing from it is lost. */
async function handleSession(ctx: CommandContext): Promise<CommandOutcome> {
  const id = ctx.args.trim();
  if (!id) {
    ctx.ui.writeError("Usage: /session <id> — see /sessions for ids. Switches to a different saved session; the current one is saved first.");
    return "continue";
  }
  if (id === ctx.session.id) {
    ctx.ui.writeSystem("Already on this session.");
    return "continue";
  }

  let target: AgentSession;
  try {
    await ctx.session.persist();
    target = await AgentSession.resume(ctx.cwd, id, ctx.session.systemPrompt);
  } catch (err) {
    ctx.ui.writeError(`Could not switch to session "${id}": ${err instanceof Error ? err.message : err}`);
    return "continue";
  }

  ctx.setSession(target);
  const label = target.title ? `"${target.title}"` : target.id;
  ctx.ui.writeSystem(`Switched to session ${label} (${target.messages.length} message(s)).`);
  return "continue";
}

/** Sets/shows/clears a standing objective for the session — kept in the model's context every turn (see systemPromptWithDate in loop.ts) until cleared, so it survives across many turns instead of being a one-off instruction that fades after a few exchanges. */
async function handleGoal(ctx: CommandContext): Promise<CommandOutcome> {
  const args = ctx.args.trim();

  if (args === "") {
    ctx.ui.writeSystem(
      ctx.session.goal
        ? `Current goal: ${ctx.session.goal}`
        : "No goal set for this session. Usage: /goal <text> to set one, /goal clear to remove it.",
    );
    return "continue";
  }

  if (args === "clear") {
    if (!ctx.session.goal) {
      ctx.ui.writeSystem("No goal was set.");
      return "continue";
    }
    ctx.session.goal = undefined;
    await ctx.session.persist();
    ctx.ui.writeSystem("Goal cleared.");
    return "continue";
  }

  ctx.session.goal = args;
  await ctx.session.persist();
  ctx.ui.writeSystem(`Goal set: ${args}`);
  return "continue";
}

export const CONFIG_KEYS = [
  "provider",
  "model",
  "baseUrl",
  "apiKey",
  "visionProvider",
  "visionModel",
  "visionBaseUrl",
  "visionApiKey",
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export const SECRET_KEYS: readonly ConfigKey[] = ["apiKey", "visionApiKey"];

function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

export function maskSecret(value: string): string {
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function formatConfig(config: FinanfaConfig): string {
  const entries = Object.entries(config) as [ConfigKey, string][];
  if (entries.length === 0) return `No config set. Use /config set <${CONFIG_KEYS.join("|")}> <value>.`;
  return entries.map(([k, v]) => `${k}: ${SECRET_KEYS.includes(k) ? maskSecret(v) : v}`).join("\n");
}

async function handleConfig(ctx: CommandContext): Promise<CommandOutcome> {
  const parts = ctx.args.trim().split(/\s+/).filter(Boolean);
  const [sub] = parts;

  if (!sub || sub === "show") {
    ctx.ui.writeSystem(formatConfig(await loadConfig(ctx.cwd)));
    return "continue";
  }

  if (sub === "set") {
    const key = parts[1];
    const value = parts.slice(2).join(" ");
    if (!key || !isConfigKey(key) || !value) {
      ctx.ui.writeError(`Usage: /config set <${CONFIG_KEYS.join("|")}> <value>`);
      return "continue";
    }
    const current = await loadConfig(ctx.cwd);
    await saveGlobalConfig({ ...current, [key]: value });
    ctx.ui.writeSystem(`Saved ${key} to ${globalConfigPath()}. Restart finanfa-code for it to take effect.`);
    return "continue";
  }

  if (sub === "clear") {
    await saveGlobalConfig({});
    ctx.ui.writeSystem("Config cleared.");
    return "continue";
  }

  ctx.ui.writeError(`Usage: /config [show] | /config set <${CONFIG_KEYS.join("|")}> <value> | /config clear`);
  return "continue";
}

export function registerBuiltinCommands(commands: CommandRegistry): void {
  commands.register("exit", () => "exit", "Quit finanfa-code");

  commands.register(
    "cost",
    (ctx) => {
      const status = ctx.ui.getStatus();
      ctx.ui.writeSystem(
        status
          ? `tokens=${status.tokens} cost=$${status.costUsd.toFixed(4)} model=${status.model}`
          : "No usage recorded yet.",
      );
      return "continue";
    },
    "Show token usage and estimated cost for this session",
  );

  commands.register(
    "clear",
    async (ctx): Promise<CommandOutcome> => {
      ctx.session.messages = [];
      await ctx.session.persist();
      ctx.ui.writeSystem("Conversation history cleared (session id unchanged).");
      return "continue";
    },
    "Clear the conversation history, keeping the same session",
  );

  commands.register(
    "help",
    (ctx) => {
      ctx.ui.writeSystem(commands.list().map((c) => `/${c.name} — ${c.description}`).join("\n"));
      return "continue";
    },
    "List available commands",
  );

  commands.register(
    "undo",
    handleUndo,
    "Revert the most recent file write/edit made by the agent",
  );

  commands.register("todos", handleTodos, "Show the current task checklist");
  commands.register("memory", handleMemory, "List saved project memory notes (name, type, description)");

  commands.register(
    "config",
    handleConfig,
    "Show/set persistent defaults (provider, model, baseUrl, apiKey): /config [show] | /config set <key> <value> | /config clear",
  );

  commands.register(
    "mcp",
    handleMcp,
    "Manage MCP servers: /mcp list | /mcp reload | /mcp add <name> -- <command> [args...] | " +
      "/mcp connect <name> | /mcp enable <name> | /mcp disable <name>",
  );
  commands.register(
    "sessions",
    handleSessions,
    "List saved sessions for this directory, /sessions delete <id>, or /sessions delete all (keeps the current one)",
  );
  commands.register(
    "session",
    handleSession,
    "Switch to a different saved session by id (see /sessions for ids) — saves the current one first",
  );
  commands.register(
    "goal",
    handleGoal,
    "Set a standing goal for this session (/goal <text>), show it (/goal), or remove it (/goal clear)",
  );
}
