import { createRequire } from "node:module";
import { Command } from "commander";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import { runTurn, maybeGenerateTitle, type VisionRoute } from "@finanfa/core/src/core/loop.js";
import type { UIAdapter } from "@finanfa/core/src/ui/adapter.js";
import { createReadlineAdapter } from "./ui/readline-adapter.js";
import { createInkAdapter } from "./ui/ink/ink-adapter.js";
import { ToolRegistry } from "@finanfa/core/src/tools/registry.js";
import { registerBuiltins, registerStatefulBuiltins } from "@finanfa/core/src/tools/builtin/index.js";
import { PermissionManager } from "@finanfa/core/src/permissions/manager.js";
import { loadPermissionConfig } from "@finanfa/core/src/permissions/config.js";
import { CommandRegistry } from "@finanfa/core/src/commands/registry.js";
import { registerBuiltinCommands } from "@finanfa/core/src/commands/builtin.js";
import type { CommandOutcome } from "@finanfa/core/src/commands/types.js";
import { McpClientManager } from "@finanfa/core/src/mcp/client-manager.js";
import { loadPlugins } from "@finanfa/core/src/plugins/loader.js";
import { loadSkills, formatSkillIndex, createReadSkillTool } from "@finanfa/core/src/skills/loader.js";
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool } from "@finanfa/core/src/memory/loader.js";
import { loadProjectInstructions, formatProjectInstructions } from "@finanfa/core/src/core/project-instructions.js";
import { loadDesignContract } from "@finanfa/core/src/core/design-contract.js";
import { BrowserManager } from "@finanfa/core/src/browser/manager.js";
import type { LlmProvider } from "@finanfa/core/src/core/types.js";
import { loadConfig } from "@finanfa/core/src/core/config.js";
import {
  BASE_SYSTEM_PROMPT,
  SECURITY_INSTRUCTION,
  selectProvider,
  selectVisionProvider,
  connectMcpServers,
} from "@finanfa/core/src/app.js";

export { BASE_SYSTEM_PROMPT, SECURITY_INSTRUCTION, connectMcpServers };

// createRequire (not import ... with { type: "json" }) so this works
// identically whether cli.ts runs from src/ directly (tsx, dev) or from the
// tsup-bundled dist/ output — ../package.json resolves to the project root
// either way.
const PACKAGE_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export interface CliOptions {
  resume?: string;
  continue?: boolean;
  model?: string;
  yolo?: boolean;
  nonInteractive?: boolean;
  ui: "ink" | "readline";
}

function createUi(mode: "ink" | "readline"): UIAdapter {
  // Ink needs an interactive TTY to manage raw input/output; fall back to the
  // readline adapter automatically when stdin isn't one (e.g. CI, pipes).
  if (mode === "ink" && process.stdin.isTTY) return createInkAdapter();
  return createReadlineAdapter();
}

export async function resolveSession(
  cwd: string,
  opts: CliOptions,
  model: string,
  systemPrompt: string,
  ui: UIAdapter,
): Promise<AgentSession> {
  const idToResume = opts.resume ?? (opts.continue ? await AgentSession.findLatest(cwd) : undefined);
  if (idToResume) {
    try {
      return await AgentSession.resume(cwd, idToResume, systemPrompt);
    } catch (err) {
      // A stale/typo'd --resume id, or a corrupted session file, used to
      // crash the whole CLI at startup with a raw stack trace before the UI
      // was even usable. Warn and fall back to a fresh session instead —
      // same "warn and continue" policy as AgentSession.persist().
      ui.writeError(
        `Could not resume session "${idToResume}": ${err instanceof Error ? err.message : String(err)}. Starting a new session instead.`,
      );
    }
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
  getSession: () => AgentSession,
  mcp: McpClientManager,
  browser: BrowserManager,
  ui: UIAdapter,
): void {
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    ui.writeSystem("Interrupted — saving session and closing connections...");
    // A getter, not a captured session — /session may have swapped the
    // REPL's active session since this handler was registered, and Ctrl+C
    // should act on whichever one is actually current, not the one from
    // startup.
    const session = getSession();
    // Aborts every in-flight tool call's signal (see runOneToolCall in
    // loop.ts) BEFORE persisting/exiting — a bash/run_tests subprocess only
    // gets cleanly killed (not orphaned) if this fires first; process.exit()
    // below does not wait for or otherwise reap a detached child on its own.
    for (const controller of session.activeAbortControllers) controller.abort();
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

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("finanfa")
    .description("finanfa-code: a from-scratch AI coding agent CLI")
    .version(PACKAGE_VERSION, "-v, --version", "output the current version")
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
  ui.writeBanner(PACKAGE_VERSION);

  const config = await loadConfig(cwd);
  const { provider, defaultModel, kind: providerKind } = selectProvider(config);
  const model = opts.model ?? defaultModel;
  const visionRoute = selectVisionProvider(config);

  const tools = new ToolRegistry();
  registerBuiltins(tools, { sandbox: config.sandbox });

  const skills = await loadSkills(cwd);
  if (skills.length > 0) tools.register(createReadSkillTool(skills));

  tools.register(writeMemoryTool);
  const memories = await loadMemories(cwd);
  if (memories.length > 0) tools.register(createReadMemoryTool(cwd));

  const projectInstructions = await loadProjectInstructions(cwd);
  const designContract = await loadDesignContract(cwd);

  const systemPrompt =
    BASE_SYSTEM_PROMPT + formatSkillIndex(skills) + formatMemoryIndex(memories) + formatProjectInstructions(projectInstructions);

  const session = await resolveSession(cwd, opts, model, systemPrompt, ui);

  const permissionConfig = await loadPermissionConfig(cwd);
  const permissions = new PermissionManager({
    config: permissionConfig,
    ui,
    yolo: opts.yolo,
    nonInteractive: opts.nonInteractive,
  });

  const mcp = new McpClientManager();
  const browser = new BrowserManager();

  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);
  const plugins = await loadPlugins(cwd, tools, commands);
  ui.setCommands(commands.list());

  // Built as a named, mutable variable (not an inline object literal at the
  // repl() call site) specifically so registerShutdownHandlers below can
  // close over it via a getter — /session can swap deps.session mid-run,
  // and Ctrl+C needs to persist whichever session is current then, not the
  // one that existed at startup.
  const deps: ReplDeps = { session, provider, ui, tools, permissions, mcp, commands, cwd, visionRoute };
  registerShutdownHandlers(() => deps.session, mcp, browser, ui);

  await connectMcpServers(cwd, mcp, ui);
  for (const def of await mcp.listAllTools()) tools.register(def);

  registerStatefulBuiltins(tools, { provider, permissions, ui, model, cwd, browser, designContract: designContract.content });

  ui.writeSystem(`session ${session.id} · ${session.model} via ${providerKind} · ${tools.list().length} tools loaded`);
  if (mcp.connectedServers().length > 0) ui.writeSystem(`MCP servers: ${mcp.connectedServers().join(", ")}`);
  if (plugins.length > 0) ui.writeSystem(`Plugins: ${plugins.join(", ")}`);
  if (opts.yolo) ui.writeSystem("⚠ --yolo: all tool calls will be auto-approved");
  if (visionRoute) ui.writeSystem(`Vision routing: image turns use ${visionRoute.model}`);
  ui.writeSystem(`Type / to see available commands, or /help for details.`);

  await repl(deps);
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
  visionRoute?: VisionRoute;
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
  return handler({
    ...deps,
    args: rest.join(" "),
    // Mutates deps itself (not a local copy) so repl()'s loop — which reads
    // deps.session fresh every iteration, not a destructured snapshot —
    // picks up the switch on the very next turn.
    setSession: (session) => {
      deps.session = session;
    },
  });
}

async function repl(deps: ReplDeps): Promise<void> {
  const { ui, provider, tools, permissions, visionRoute } = deps;

  for (;;) {
    const input = await ui.askUser("\n> ");
    const trimmed = input.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("/")) {
      if ((await runSlashCommand(deps, trimmed)) === "exit") return;
      continue;
    }

    try {
      await runTurn(deps.session, provider, ui, tools, permissions, trimmed, visionRoute);
      await maybeGenerateTitle(deps.session, provider);
    } catch (err) {
      ui.writeError(err instanceof Error ? err.message : String(err));
    }
  }
}
