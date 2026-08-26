import { Command } from "commander";
import { AgentSession } from "./core/session.js";
import { runTurn } from "./core/loop.js";
import { createReadlineAdapter } from "./ui/readline-adapter.js";

const DEFAULT_SYSTEM_PROMPT = "You are finanfa-code, a helpful coding assistant.";
const DEFAULT_MODEL = "claude-sonnet-5";

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("finanfa")
    .description("finanfa-code: a from-scratch AI coding agent CLI")
    .option("-r, --resume <sessionId>", "resume a specific session by id")
    .option("-c, --continue", "resume the most recent session for this directory")
    .option("-m, --model <model>", "model to use", DEFAULT_MODEL)
    .parse(argv);

  const opts = program.opts<{ resume?: string; continue?: boolean; model: string }>();
  const cwd = process.cwd();

  let session: AgentSession;
  if (opts.resume) {
    session = await AgentSession.resume(cwd, opts.resume);
  } else if (opts.continue) {
    const latest = await AgentSession.findLatest(cwd);
    session = latest
      ? await AgentSession.resume(cwd, latest)
      : new AgentSession({ cwd, model: opts.model, systemPrompt: DEFAULT_SYSTEM_PROMPT });
  } else {
    session = new AgentSession({ cwd, model: opts.model, systemPrompt: DEFAULT_SYSTEM_PROMPT });
  }

  const ui = createReadlineAdapter();
  ui.writeSystem(`finanfa-code — session ${session.id} (${session.model})`);
  ui.writeSystem("Commands: /cost, /exit");

  for (;;) {
    const input = await ui.askUser("\n> ");
    const trimmed = input.trim();

    if (trimmed === "/exit") break;
    if (trimmed === "/cost") {
      const status = ui.getStatus();
      ui.writeSystem(
        status
          ? `tokens=${status.tokens} cost=$${status.costUsd.toFixed(4)} model=${status.model}`
          : "No usage recorded yet.",
      );
      continue;
    }
    if (trimmed === "") continue;

    try {
      await runTurn(session, ui, trimmed);
    } catch (err) {
      ui.writeError(err instanceof Error ? err.message : String(err));
    }
  }

  ui.close();
}
