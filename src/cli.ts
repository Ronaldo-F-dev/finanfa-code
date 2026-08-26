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

const DEFAULT_SYSTEM_PROMPT =
  "You are finanfa-code, a helpful coding assistant with access to file and shell tools. " +
  "Prefer edit_file over write_file for existing files. Always explain what you're about to do before calling a tool.";
const DEFAULT_MODEL = "claude-sonnet-5";

interface CliOptions {
  resume?: string;
  continue?: boolean;
  model: string;
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

async function resolveSession(cwd: string, opts: CliOptions): Promise<AgentSession> {
  if (opts.resume) {
    return AgentSession.resume(cwd, opts.resume);
  }
  if (opts.continue) {
    const latest = await AgentSession.findLatest(cwd);
    if (latest) return AgentSession.resume(cwd, latest);
  }
  return new AgentSession({ cwd, model: opts.model, systemPrompt: DEFAULT_SYSTEM_PROMPT });
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("finanfa")
    .description("finanfa-code: a from-scratch AI coding agent CLI")
    .option("-r, --resume <sessionId>", "resume a specific session by id")
    .option("-c, --continue", "resume the most recent session for this directory")
    .option("-m, --model <model>", "model to use", DEFAULT_MODEL)
    .option("--yolo", "auto-approve every tool call without prompting (dangerous)")
    .option("--non-interactive", "never prompt; auto-deny anything not pre-allowed by config")
    .option("--ui <mode>", "terminal UI: ink or readline", "ink")
    .parse(argv);

  const opts = program.opts<CliOptions>();
  const cwd = process.cwd();
  const session = await resolveSession(cwd, opts);

  const ui = createUi(opts.ui);
  const tools = new ToolRegistry();
  registerBuiltins(tools);

  const permissionConfig = await loadPermissionConfig(cwd);
  const permissions = new PermissionManager({
    config: permissionConfig,
    ui,
    yolo: opts.yolo,
    nonInteractive: opts.nonInteractive,
  });

  ui.writeSystem(`finanfa-code — session ${session.id} (${session.model})`);
  ui.writeSystem(`Tools: ${tools.list().map((t) => t.name).join(", ")}`);
  if (opts.yolo) ui.writeSystem("⚠ --yolo: all tool calls will be auto-approved");
  ui.writeSystem("Commands: /cost, /exit");

  await repl(session, ui, tools, permissions);
  ui.close();
}

function printCost(ui: UIAdapter): void {
  const status = ui.getStatus();
  ui.writeSystem(
    status
      ? `tokens=${status.tokens} cost=$${status.costUsd.toFixed(4)} model=${status.model}`
      : "No usage recorded yet.",
  );
}

async function repl(
  session: AgentSession,
  ui: UIAdapter,
  tools: ToolRegistry,
  permissions: PermissionManager,
): Promise<void> {
  for (;;) {
    const input = await ui.askUser("\n> ");
    const trimmed = input.trim();

    if (trimmed === "/exit") return;
    if (trimmed === "/cost") {
      printCost(ui);
      continue;
    }
    if (trimmed === "") continue;

    try {
      await runTurn(session, ui, tools, permissions, trimmed);
    } catch (err) {
      ui.writeError(err instanceof Error ? err.message : String(err));
    }
  }
}
