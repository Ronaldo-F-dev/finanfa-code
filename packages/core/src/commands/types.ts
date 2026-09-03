import type { AgentSession } from "../core/session.js";
import type { UIAdapter } from "../ui/adapter.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionManager } from "../permissions/manager.js";
import type { McpClientManager } from "../mcp/client-manager.js";

export interface CommandContext {
  session: AgentSession;
  ui: UIAdapter;
  tools: ToolRegistry;
  permissions: PermissionManager;
  mcp: McpClientManager;
  cwd: string;
  args: string;
  /** Switches the REPL's active session for subsequent turns (see /session) — persist the outgoing session yourself first if it should be kept. */
  setSession: (session: AgentSession) => void;
}

export type CommandOutcome = "continue" | "exit";
export type CommandHandler = (ctx: CommandContext) => Promise<CommandOutcome> | CommandOutcome;
