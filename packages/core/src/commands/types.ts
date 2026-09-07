import type { AgentSession } from "../core/session.js";
import type { UIAdapter } from "../ui/adapter.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionManager } from "../permissions/manager.js";
import type { McpClientManager } from "../mcp/client-manager.js";
import type { LlmProvider } from "../core/types.js";
import type { CustomCommand } from "./custom-commands.js";

export interface CommandContext {
  session: AgentSession;
  ui: UIAdapter;
  tools: ToolRegistry;
  permissions: PermissionManager;
  mcp: McpClientManager;
  provider: LlmProvider;
  cwd: string;
  args: string;
  /** Switches the REPL's active session for subsequent turns (see /session) — persist the outgoing session yourself first if it should be kept. */
  setSession: (session: AgentSession) => void;
  /** Loaded .finanfa-code/commands/*.md shortcuts (see custom-commands.ts) — optional so direct unit tests of a builtin command don't need to supply it; only /help currently reads it, to list them alongside builtins. */
  customCommands?: Map<string, CustomCommand>;
}

export type CommandOutcome = "continue" | "exit";
export type CommandHandler = (ctx: CommandContext) => Promise<CommandOutcome> | CommandOutcome;
