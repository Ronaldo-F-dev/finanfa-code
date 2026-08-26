import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { AgentSession } from "../core/session.js";
import { loadMcpServers, type McpServerConfig } from "../mcp/config.js";
import { MCP_TOOL_PREFIX } from "../mcp/client-manager.js";
import type { CommandContext, CommandOutcome } from "./types.js";
import type { CommandRegistry } from "./registry.js";

async function reloadMcpTools(ctx: CommandContext): Promise<void> {
  ctx.tools.unregisterByPrefix(MCP_TOOL_PREFIX);
  const definitions = await ctx.mcp.listAllTools();
  for (const def of definitions) ctx.tools.register(def);
}

async function handleMcp(ctx: CommandContext): Promise<CommandOutcome> {
  const [sub, ...rest] = ctx.args.trim().split(/\s+/);

  if (sub === "list") {
    const connected = ctx.mcp.connectedServers();
    ctx.ui.writeSystem(
      connected.length > 0 ? `Connected MCP servers: ${connected.join(", ")}` : "No MCP servers connected.",
    );
    return "continue";
  }

  if (sub === "reload") {
    await reloadMcpTools(ctx);
    ctx.ui.writeSystem("MCP tools reloaded.");
    return "continue";
  }

  if (sub === "add") {
    // Usage: /mcp add <name> -- <command> [args...]
    const joined = rest.join(" ");
    const [namePart, cmdPart] = joined.split("--").map((s) => s.trim());
    if (!namePart || !cmdPart) {
      ctx.ui.writeError("Usage: /mcp add <name> -- <command> [args...]");
      return "continue";
    }
    const [command, ...cmdArgs] = cmdPart.split(/\s+/);
    const file = path.join(ctx.cwd, ".finanfa-code", "mcp.json");
    const existing = await loadMcpServers(ctx.cwd);
    const next: McpServerConfig[] = [
      ...existing.filter((s) => s.name !== namePart),
      { name: namePart, transport: "stdio", command, args: cmdArgs },
    ];
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ servers: next }, null, 2), "utf-8");
    await ctx.mcp.connect(next[next.length - 1]);
    await reloadMcpTools(ctx);
    ctx.ui.writeSystem(`Added and connected MCP server "${namePart}".`);
    return "continue";
  }

  ctx.ui.writeError("Usage: /mcp list | /mcp reload | /mcp add <name> -- <command> [args...]");
  return "continue";
}

async function handleSessions(ctx: CommandContext): Promise<CommandOutcome> {
  const [sub, id] = ctx.args.trim().split(/\s+/);

  if (sub === "delete" && id) {
    await AgentSession.delete(ctx.cwd, id);
    ctx.ui.writeSystem(`Deleted session ${id}.`);
    return "continue";
  }

  const sessions = await AgentSession.list(ctx.cwd);
  if (sessions.length === 0) {
    ctx.ui.writeSystem("No saved sessions for this directory.");
    return "continue";
  }
  ctx.ui.writeSystem(
    sessions
      .map((s) => `${s.id}${s.id === ctx.session.id ? " (current)" : ""} — ${s.mtime.toISOString()}`)
      .join("\n"),
  );
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
    "mcp",
    handleMcp,
    "Manage MCP servers: /mcp list | /mcp reload | /mcp add <name> -- <command> [args...]",
  );
  commands.register(
    "sessions",
    handleSessions,
    "List saved sessions for this directory, or /sessions delete <id>",
  );
}
