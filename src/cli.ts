import { Command } from "commander";
import { AgentSession } from "./core/session.js";
import { runTurn } from "./core/loop.js";
import type { UIAdapter } from "./ui/adapter.js";
import { createReadlineAdapter } from "./ui/readline-adapter.js";
import { createInkAdapter } from "./ui/ink/ink-adapter.js";
import { ToolRegistry } from "./tools/registry.js";
import { registerBuiltins } from "./tools/builtin/index.js";
import { PermissionManager } from "./permissions/manager.js";
import { loadPermissionConfig } from "./permissions/config.js";
import { CommandRegistry } from "./commands/registry.js";
import { registerBuiltinCommands } from "./commands/builtin.js";
import { McpClientManager } from "./mcp/client-manager.js";
import { loadMcpServers } from "./mcp/config.js";
import { loadPlugins } from "./plugins/loader.js";
import { loadSkills, formatSkillIndex, createReadSkillTool } from "./skills/loader.js";
import type { LlmProvider } from "./core/types.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible-provider.js";

const BASE_SYSTEM_PROMPT =
  "You are finanfa-code, a helpful coding assistant with access to file and shell tools. " +
  "Prefer edit_file over write_file for existing files. Always explain what you're about to do before calling a tool.";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

interface CliOptions {
  resume?: string;
  continue?: boolean;
  model?: string;
  yolo?: boolean;
  nonInteractive?: boolean;
  ui: "ink" | "readline";
}

/**
 * Picks the LLM backend from environment variables:
 *  - default: Anthropic, using ANTHROPIC_API_KEY
 *  - FINANFA_PROVIDER=openai-compatible: any server speaking the OpenAI
 *    chat-completions wire format — Ollama (local, free), OpenRouter,
 *    Poolside, LM Studio, vLLM, etc. — configured via FINANFA_BASE_URL /
 *    FINANFA_API_KEY / FINANFA_MODEL.
 */
function selectProvider(): { provider: LlmProvider; defaultModel: string } {
  if (process.env.FINANFA_PROVIDER === "openai-compatible") {
    const baseUrl = process.env.FINANFA_BASE_URL;
    const model = process.env.FINANFA_MODEL;
    if (!baseUrl || !model) {
      throw new Error(
        "FINANFA_PROVIDER=openai-compatible requires FINANFA_BASE_URL and FINANFA_MODEL " +
          "(FINANFA_API_KEY is optional, e.g. for a local Ollama server that needs no key).",
      );
    }
    return {
      provider: new OpenAiCompatibleProvider({ baseUrl, apiKey: process.env.FINANFA_API_KEY }),
      defaultModel: model,
    };
  }
  return { provider: new AnthropicProvider(process.env.ANTHROPIC_API_KEY), defaultModel: DEFAULT_ANTHROPIC_MODEL };
}

function createUi(mode: "ink" | "readline"): UIAdapter {
  // Ink needs an interactive TTY to manage raw input/output; fall back to the
  // readline adapter automatically when stdin isn't one (e.g. CI, pipes).
  if (mode === "ink" && process.stdin.isTTY) return createInkAdapter();
  return createReadlineAdapter();
}

async function resolveSession(
  cwd: string,
  opts: CliOptions,
  model: string,
  systemPrompt: string,
): Promise<AgentSession> {
  if (opts.resume) {
    return AgentSession.resume(cwd, opts.resume, systemPrompt);
  }
  if (opts.continue) {
    const latest = await AgentSession.findLatest(cwd);
    if (latest) return AgentSession.resume(cwd, latest, systemPrompt);
  }
  return new AgentSession({ cwd, model, systemPrompt });
}

async function connectMcpServers(cwd: string, mcp: McpClientManager, ui: UIAdapter): Promise<void> {
  const servers = await loadMcpServers(cwd);
  for (const server of servers) {
    try {
      await mcp.connect(server);
    } catch (err) {
      ui.writeError(`Failed to connect MCP server "${server.name}": ${err instanceof Error ? err.message : err}`);
    }
  }
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("finanfa")
    .description("finanfa-code: a from-scratch AI coding agent CLI")
    .option("-r, --resume <sessionId>", "resume a specific session by id")
    .option("-c, --continue", "resume the most recent session for this directory")
    .option("-m, --model <model>", "model to use (defaults depend on the active provider)")
    .option("--yolo", "auto-approve every tool call without prompting (dangerous)")
    .option("--non-interactive", "never prompt; auto-deny anything not pre-allowed by config")
    .option("--ui <mode>", "terminal UI: ink or readline", "ink")
    .parse(argv);

  const opts = program.opts<CliOptions>();
  const cwd = process.cwd();
  const ui = createUi(opts.ui);

  const { provider, defaultModel } = selectProvider();
  const model = opts.model ?? defaultModel;

  const tools = new ToolRegistry();
  registerBuiltins(tools);

  const skills = await loadSkills(cwd);
  if (skills.length > 0) tools.register(createReadSkillTool(skills));
  const systemPrompt = BASE_SYSTEM_PROMPT + formatSkillIndex(skills);

  const session = await resolveSession(cwd, opts, model, systemPrompt);

  const permissionConfig = await loadPermissionConfig(cwd);
  const permissions = new PermissionManager({
    config: permissionConfig,
    ui,
    yolo: opts.yolo,
    nonInteractive: opts.nonInteractive,
  });

  const mcp = new McpClientManager();
  await connectMcpServers(cwd, mcp, ui);
  for (const def of await mcp.listAllTools()) tools.register(def);

  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);
  const plugins = await loadPlugins(cwd, tools, commands);
  ui.setCommands(commands.list());

  const providerLabel = process.env.FINANFA_PROVIDER === "openai-compatible" ? "openai-compatible" : "anthropic";
  ui.writeSystem(`finanfa-code — session ${session.id} (${session.model} via ${providerLabel})`);
  ui.writeSystem(`Tools: ${tools.list().map((t) => t.name).join(", ")}`);
  if (mcp.connectedServers().length > 0) ui.writeSystem(`MCP servers: ${mcp.connectedServers().join(", ")}`);
  if (plugins.length > 0) ui.writeSystem(`Plugins: ${plugins.join(", ")}`);
  if (opts.yolo) ui.writeSystem("⚠ --yolo: all tool calls will be auto-approved");
  ui.writeSystem(`Type / to see available commands, or /help for details.`);

  await repl(session, provider, ui, tools, permissions, mcp, commands, cwd);
  await mcp.disconnectAll();
  ui.close();
}

async function repl(
  session: AgentSession,
  provider: LlmProvider,
  ui: UIAdapter,
  tools: ToolRegistry,
  permissions: PermissionManager,
  mcp: McpClientManager,
  commands: CommandRegistry,
  cwd: string,
): Promise<void> {
  for (;;) {
    const input = await ui.askUser("\n> ");
    const trimmed = input.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("/")) {
      const [name, ...rest] = trimmed.slice(1).split(/\s+/);
      const handler = commands.get(name);
      if (!handler) {
        ui.writeError(`Unknown command "/${name}". Available: ${commands.names().map((n) => `/${n}`).join(", ")}`);
        continue;
      }
      const outcome = await handler({ session, ui, tools, permissions, mcp, cwd, args: rest.join(" ") });
      if (outcome === "exit") return;
      continue;
    }

    try {
      await runTurn(session, provider, ui, tools, permissions, trimmed);
    } catch (err) {
      ui.writeError(err instanceof Error ? err.message : String(err));
    }
  }
}
