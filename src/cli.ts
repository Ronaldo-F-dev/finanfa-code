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
import type { CommandOutcome } from "./commands/types.js";
import { McpClientManager } from "./mcp/client-manager.js";
import { loadMcpServers } from "./mcp/config.js";
import { loadPlugins } from "./plugins/loader.js";
import { loadSkills, formatSkillIndex, createReadSkillTool } from "./skills/loader.js";
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool } from "./memory/loader.js";
import { createTaskTool } from "./tools/builtin/task.js";
import { createBrowserTools } from "./tools/builtin/browser.js";
import { BrowserManager } from "./browser/manager.js";
import type { LlmProvider } from "./core/types.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible-provider.js";
import { loadConfig, type FinanfaConfig } from "./core/config.js";

const BASE_SYSTEM_PROMPT =
  "You are finanfa-code, a helpful coding assistant with access to file and shell tools. " +
  "Prefer edit_file over write_file for existing files. Always explain what you're about to do before calling a tool. " +
  "When asked to design or mock up a UI, write a clean, single-file HTML/CSS/JS mockup with write_file, then offer " +
  "to open it for the user with preview_html. Delegate independent, parallelizable pieces of work to the task tool. " +
  "For any multi-step task, use todo_write up front to plan the steps, and update it as you complete each one. " +
  "web_fetch only returns stripped text — it cannot show you what a page actually looks like. Whenever the user " +
  "asks you to look at, see, describe the appearance of, or take a screenshot/capture of a web page, use " +
  "browser_navigate followed by browser_screenshot instead (call browser_navigate again first if the page isn't " +
  "already open from earlier in the conversation) — never answer a visual request with web_fetch's text dump. " +
  "Use view_image the same way for an existing local image file. " +
  "Prefer the dedicated git_status/git_diff/git_log/git_branch/git_add/git_commit/git_checkout tools over bash " +
  "for git operations they cover — bash still works for anything else (push, merge, rebase, ...). " +
  "After changing code, run run_tests, read any failures carefully, fix the underlying cause, and re-run — " +
  "repeat this test/fix loop until it passes. If the same failure survives about 3 fix attempts, stop and " +
  "explain what's blocking you instead of continuing to guess. " +
  "When the user states a lasting preference, corrects your approach, or shares project context that isn't " +
  "obvious from the code (a deadline, a past incident, why something is built a certain way), use write_memory " +
  "so the next session in this project starts with that context — but not for things already derivable by " +
  "reading the repo or git history.";
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
 * Picks the LLM backend. Priority per setting: environment variable > config
 * file (project-local .finanfa-code/config.json, then global
 * ~/.finanfa-code/config.json, see /config) > built-in default.
 *  - provider "anthropic" (default): uses ANTHROPIC_API_KEY / config.apiKey.
 *  - provider "openai-compatible": any server speaking the OpenAI
 *    chat-completions wire format — Ollama (local, free), OpenRouter,
 *    Poolside, LM Studio, vLLM, etc. — needs baseUrl + model (apiKey optional,
 *    e.g. for a local Ollama server that needs no key).
 */
function selectProvider(config: FinanfaConfig): { provider: LlmProvider; defaultModel: string; kind: string } {
  const kind = process.env.FINANFA_PROVIDER ?? config.provider ?? "anthropic";

  if (kind === "openai-compatible") {
    const baseUrl = process.env.FINANFA_BASE_URL ?? config.baseUrl;
    const model = process.env.FINANFA_MODEL ?? config.model;
    const apiKey = process.env.FINANFA_API_KEY ?? config.apiKey;
    if (!baseUrl || !model) {
      throw new Error(
        "provider openai-compatible requires a base URL and model — set FINANFA_BASE_URL/FINANFA_MODEL, " +
          "or /config set baseUrl <url> and /config set model <model>.",
      );
    }
    return { provider: new OpenAiCompatibleProvider({ baseUrl, apiKey }), defaultModel: model, kind };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY ?? config.apiKey;
  return {
    provider: new AnthropicProvider(apiKey),
    defaultModel: config.model ?? DEFAULT_ANTHROPIC_MODEL,
    kind: "anthropic",
  };
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

/**
 * Persists the session and closes MCP connections before exiting, instead of
 * letting SIGINT/SIGTERM kill the process mid-write. Ink's raw-mode Ctrl+C
 * handling is redirected into a real SIGINT (see App.tsx) so both UI modes
 * go through this same path.
 */
function registerShutdownHandlers(
  session: AgentSession,
  mcp: McpClientManager,
  browser: BrowserManager,
  ui: UIAdapter,
): void {
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    ui.writeSystem("Interrupted — saving session and closing connections...");
    try {
      await session.persist();
    } catch (err) {
      ui.writeError(`Failed to save session: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await mcp.disconnectAll();
    } catch {
      // Best-effort on the way out.
    }
    await browser.close().catch(() => {});
    ui.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
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

  const config = await loadConfig(cwd);
  const { provider, defaultModel, kind: providerKind } = selectProvider(config);
  const model = opts.model ?? defaultModel;

  const tools = new ToolRegistry();
  registerBuiltins(tools);

  const skills = await loadSkills(cwd);
  if (skills.length > 0) tools.register(createReadSkillTool(skills));

  tools.register(writeMemoryTool);
  const memories = await loadMemories(cwd);
  if (memories.length > 0) tools.register(createReadMemoryTool(cwd));

  const systemPrompt = BASE_SYSTEM_PROMPT + formatSkillIndex(skills) + formatMemoryIndex(memories);

  const session = await resolveSession(cwd, opts, model, systemPrompt);

  const permissionConfig = await loadPermissionConfig(cwd);
  const permissions = new PermissionManager({
    config: permissionConfig,
    ui,
    yolo: opts.yolo,
    nonInteractive: opts.nonInteractive,
  });

  const mcp = new McpClientManager();
  const browser = new BrowserManager();
  registerShutdownHandlers(session, mcp, browser, ui);
  await connectMcpServers(cwd, mcp, ui);
  for (const def of await mcp.listAllTools()) tools.register(def);

  tools.register(createTaskTool({ provider, tools, permissions, ui, model, cwd }));
  for (const tool of createBrowserTools(browser)) tools.register(tool);

  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);
  const plugins = await loadPlugins(cwd, tools, commands);
  ui.setCommands(commands.list());

  ui.writeSystem(`finanfa-code — session ${session.id} (${session.model} via ${providerKind})`);
  ui.writeSystem(`Tools: ${tools.list().map((t) => t.name).join(", ")}`);
  if (mcp.connectedServers().length > 0) ui.writeSystem(`MCP servers: ${mcp.connectedServers().join(", ")}`);
  if (plugins.length > 0) ui.writeSystem(`Plugins: ${plugins.join(", ")}`);
  if (opts.yolo) ui.writeSystem("⚠ --yolo: all tool calls will be auto-approved");
  ui.writeSystem(`Type / to see available commands, or /help for details.`);

  await repl({ session, provider, ui, tools, permissions, mcp, commands, cwd });
  await mcp.disconnectAll();
  await browser.close();
  ui.close();
}

interface ReplDeps {
  session: AgentSession;
  provider: LlmProvider;
  ui: UIAdapter;
  tools: ToolRegistry;
  permissions: PermissionManager;
  mcp: McpClientManager;
  commands: CommandRegistry;
  cwd: string;
}

async function runSlashCommand(deps: ReplDeps, trimmed: string): Promise<CommandOutcome> {
  const { ui, commands } = deps;
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  const handler = commands.get(name);
  if (!handler) {
    const available = commands.names().map((n) => `/${n}`).join(", ");
    ui.writeError(`Unknown command "/${name}". Available: ${available}`);
    return "continue";
  }
  return handler({ ...deps, args: rest.join(" ") });
}

async function repl(deps: ReplDeps): Promise<void> {
  const { ui, session, provider, tools, permissions } = deps;

  for (;;) {
    const input = await ui.askUser("\n> ");
    const trimmed = input.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("/")) {
      if ((await runSlashCommand(deps, trimmed)) === "exit") return;
      continue;
    }

    try {
      await runTurn(session, provider, ui, tools, permissions, trimmed);
    } catch (err) {
      ui.writeError(err instanceof Error ? err.message : String(err));
    }
  }
}
