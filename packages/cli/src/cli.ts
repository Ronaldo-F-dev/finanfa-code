import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import { runTurn, maybeGenerateTitle, isLoopGuardStopMessage, type VisionRoute } from "@finanfa/core/src/core/loop.js";
import type { UIAdapter } from "@finanfa/core/src/ui/adapter.js";
import { createReadlineAdapter } from "./ui/readline-adapter.js";
import { createInkAdapter } from "./ui/ink/ink-adapter.js";
import { ToolRegistry } from "@finanfa/core/src/tools/registry.js";
import { registerBuiltins, registerStatefulBuiltins } from "@finanfa/core/src/tools/builtin/index.js";
import { PermissionManager } from "@finanfa/core/src/permissions/manager.js";
import { loadPermissionConfig } from "@finanfa/core/src/permissions/config.js";
import { loadHooksConfig } from "@finanfa/core/src/hooks/config.js";
import { resolveTrust } from "@finanfa/core/src/core/trust-gate.js";
import { isBwrapAvailable } from "@finanfa/core/src/util/sandbox.js";
import type { HooksConfig } from "@finanfa/core/src/hooks/config.js";
import { CommandRegistry } from "@finanfa/core/src/commands/registry.js";
import { registerBuiltinCommands } from "@finanfa/core/src/commands/builtin.js";
import type { CommandOutcome } from "@finanfa/core/src/commands/types.js";
import { McpClientManager } from "@finanfa/core/src/mcp/client-manager.js";
import { loadPlugins } from "@finanfa/core/src/plugins/loader.js";
import { loadSkills, formatSkillIndex, createReadSkillTool } from "@finanfa/core/src/skills/loader.js";
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool } from "@finanfa/core/src/memory/loader.js";
import { loadCustomCommands, runCustomCommand, type CustomCommand } from "@finanfa/core/src/commands/custom-commands.js";
import { loadSubagentTypes } from "@finanfa/core/src/agents/loader.js";
import { loadProjectInstructions, formatProjectInstructions } from "@finanfa/core/src/core/project-instructions.js";
import { loadDesignContract } from "@finanfa/core/src/core/design-contract.js";
import { BrowserManager } from "@finanfa/core/src/browser/manager.js";
import type { LlmProvider } from "@finanfa/core/src/core/types.js";
import { loadConfig } from "@finanfa/core/src/core/config.js";
import { initTracing, shutdownTracing } from "@finanfa/core/src/observability/tracing.js";
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
  /** Run this one prompt non-interactively and exit instead of starting the REPL — for scripts/cron (see schedule_task). */
  prompt?: string;
  /** With --prompt: max total runTurn calls (the first plus this many auto-continues) if the step-limit guard cuts a turn off. String because commander doesn't coerce option values on its own; unset in tests that don't go through the real CLI option parser default. */
  maxTurns?: string;
  /** Project directory to operate in; defaults to process.cwd(). Needed for --prompt invocations, since a cron job's cwd is the user's home directory, not the project. */
  cwd?: string;
}

export function countConfiguredHooks(hooksConfig: HooksConfig): number {
  const events = [hooksConfig.PreToolUse, hooksConfig.PostToolUse, hooksConfig.UserPromptSubmit];
  return events.reduce((total, matchers) => total + (matchers ?? []).reduce((n, m) => n + m.hooks.length, 0), 0);
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
    await shutdownTracing().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

export async function main(argv: string[]): Promise<void> {
  await initTracing();

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
    .option("-p, --prompt <text>", "run this one prompt non-interactively and exit, instead of starting the REPL (for scripts/cron)")
    .option(
      "--max-turns <n>",
      "with --prompt: automatically send \"continue\" up to this many extra times if a turn is cut off by the " +
        "step-limit guard (a large task genuinely needing more room, not just a stuck loop) — 1 disables auto-continue",
      "5",
    )
    .option("--cwd <path>", "project directory to operate in (defaults to the current directory)")
    .parse(argv);

  const opts = program.opts<CliOptions>();
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  // Real reported bug: an explicit --cwd pointing at a directory that
  // doesn't exist yet (a fresh scratch project, the common case for a new
  // "build me an app" request) was never created — the model then had to
  // discover this itself by trying to write there and hitting a raw
  // sandbox/filesystem error, with no clear signal of what actually went
  // wrong, and (not knowing its own cwd either — see loop.ts's system
  // prompt) went on to guess at other, wrong locations instead of just
  // retrying the one it was actually given. The web server's own project
  // creation (web-server/src/projects.ts) already does exactly this
  // (mkdir before ever handing the directory to a session) — the CLI's
  // --cwd never had the same guarantee.
  if (opts.cwd) await mkdir(cwd, { recursive: true });
  // A scripted/cron --prompt invocation has no TTY to speak of; Ink needs a
  // real terminal and would otherwise throw trying to manage raw-mode
  // input on a pipe. createUi already falls back for a non-TTY stdin, but
  // --prompt forces it regardless of opts.ui, since there's no REPL to
  // render either way.
  const ui = opts.prompt ? createReadlineAdapter() : createUi(opts.ui);
  if (!opts.prompt) ui.writeBanner(PACKAGE_VERSION);

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

  const customCommands = await loadCustomCommands(cwd);
  const agentTypes = await loadSubagentTypes(cwd);

  const projectInstructions = await loadProjectInstructions(cwd);
  const designContract = await loadDesignContract(cwd);

  const systemPrompt =
    BASE_SYSTEM_PROMPT + formatSkillIndex(skills) + formatMemoryIndex(memories) + formatProjectInstructions(projectInstructions);

  const session = await resolveSession(cwd, opts, model, systemPrompt, ui);

  const trusted = await resolveTrust(cwd, ui, opts.nonInteractive);
  const permissionConfig = await loadPermissionConfig(cwd, trusted);
  const hooksConfig = await loadHooksConfig(cwd, trusted);

  // A one-time, glanceable summary of security-relevant state that's
  // otherwise invisible until something actually triggers it (a hook
  // firing, a sandboxed write failing) — sandbox/trust/hooks are all real
  // gates a user should be aware of at a glance, not just when they bite.
  const sandboxed = (config.sandbox?.mode ?? "workspace-write") === "workspace-write" && isBwrapAvailable();
  const hookCount = countConfiguredHooks(hooksConfig);
  ui.writeSystem(
    `sandbox=${sandboxed ? "on" : "off"} folder-trust=${trusted ? "trusted" : "untrusted"} hooks=${hookCount > 0 ? `${hookCount} active` : "none"}`,
  );

  const permissions = new PermissionManager({
    config: permissionConfig,
    ui,
    yolo: opts.yolo,
    nonInteractive: opts.nonInteractive,
    hooksConfig,
  });

  const mcp = new McpClientManager();
  const browser = new BrowserManager();

  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);
  const plugins = await loadPlugins(cwd, tools, commands);
  // Custom commands are listed for autocomplete alongside builtins, but
  // never override one of the same name — a builtin's fixed, code-defined
  // behavior (like /cost or /clear) always wins over a same-named project
  // shortcut, which would otherwise silently shadow it.
  ui.setCommands([
    ...commands.list(),
    ...[...customCommands.values()].filter((c) => !commands.get(c.name)).map((c) => ({ name: c.name, description: c.description })),
  ]);

  // Built as a named, mutable variable (not an inline object literal at the
  // repl() call site) specifically so registerShutdownHandlers below can
  // close over it via a getter — /session can swap deps.session mid-run,
  // and Ctrl+C needs to persist whichever session is current then, not the
  // one that existed at startup.
  const deps: ReplDeps = { session, provider, ui, tools, permissions, mcp, commands, customCommands, cwd, visionRoute };
  registerShutdownHandlers(() => deps.session, mcp, browser, ui);

  await connectMcpServers(cwd, mcp, ui);
  for (const def of await mcp.listAllTools()) tools.register(def);

  registerStatefulBuiltins(tools, { provider, permissions, ui, model, cwd, browser, designContract: designContract.content, systemPrompt, agentTypes });

  if (opts.prompt) {
    // Single-shot mode (scripts/cron via schedule_task): run exactly one
    // turn with the given prompt, persist, and exit — no REPL, no banner/
    // system-status chatter, since there's no human here to read it.
    //
    // Real reported gap: a genuinely large task (e.g. "build me a complete
    // app") reliably hits runTurn's own MAX_ITERATIONS step-limit guard well
    // before finishing — expected for a single turn, not a bug — but this
    // mode has no human to type "continue" the way an interactive REPL user
    // would to keep going. Left as one shot, the whole task just silently
    // stopped partway with no automatic way to push further. Auto-sending
    // "continue" mirrors exactly what a human would do here, bounded by
    // --max-turns so a genuinely stuck loop (the repetition-guard's own
    // "(stopped" message, which shares the same prefix) can't run forever.
    const maxTurns = Math.max(1, Number.parseInt(opts.maxTurns ?? "5", 10) || 1);
    try {
      let prompt: string = opts.prompt;
      for (let turn = 1; turn <= maxTurns; turn++) {
        await runTurn(deps.session, provider, ui, tools, permissions, prompt, visionRoute);
        const last = deps.session.messages.at(-1);
        const stoppedByGuard =
          last?.role === "assistant" && typeof last.content === "string" && isLoopGuardStopMessage(last.content);
        if (!stoppedByGuard || turn === maxTurns) break;
        ui.writeSystem(`(auto-continuing: turn ${turn} was cut off by the step-limit guard — turn ${turn + 1}/${maxTurns})`);
        prompt = "continue";
      }
      await maybeGenerateTitle(deps.session, provider);
    } catch (err) {
      ui.writeError(err instanceof Error ? err.message : String(err));
    }
    await deps.session.persist();
    await mcp.disconnectAll();
    await browser.close();
    ui.close();
    await shutdownTracing();
    return;
  }

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
  await shutdownTracing();
}

interface ReplDeps {
  session: AgentSession;
  provider: LlmProvider;
  ui: UIAdapter;
  tools: ToolRegistry;
  permissions: PermissionManager;
  mcp: McpClientManager;
  commands: CommandRegistry;
  customCommands: Map<string, CustomCommand>;
  cwd: string;
  visionRoute?: VisionRoute;
}

async function runSlashCommand(deps: ReplDeps, trimmed: string): Promise<CommandOutcome> {
  const { ui, commands, customCommands } = deps;
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  // A builtin always wins over a same-named custom command — see the
  // ui.setCommands() comment at startup for why.
  const handler = commands.get(name);
  const custom = !handler ? customCommands.get(name) : undefined;
  if (!handler && !custom) {
    const available = [...commands.names(), ...customCommands.keys()].map((n) => `/${n}`).join(", ");
    ui.writeError(`Unknown command "/${name}". Available: ${available}`);
    return "continue";
  }
  const ctx = {
    ...deps,
    args: rest.join(" "),
    // Mutates deps itself (not a local copy) so repl()'s loop — which reads
    // deps.session fresh every iteration, not a destructured snapshot —
    // picks up the switch on the very next turn.
    setSession: (session: AgentSession) => {
      deps.session = session;
    },
  };
  return custom ? runCustomCommand(ctx, custom) : handler!(ctx);
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
