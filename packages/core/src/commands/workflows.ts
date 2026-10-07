import { runTurn, maybeGenerateTitle } from "../core/loop.js";
import { OUTPUT_STYLES, findOutputStyle } from "../core/output-styles.js";
import type { CommandContext, CommandOutcome } from "./types.js";
import type { CommandRegistry } from "./registry.js";

// Prompt-driven workflows. Each one expands to a prompt and runs it through
// the real agent loop (like a custom command), so every action it takes still
// goes through the normal tool permission prompts — a workflow never gets
// extra authority just because it is built in.

async function runPrompt(ctx: CommandContext, prompt: string): Promise<void> {
  await runTurn(ctx.session, ctx.provider, ctx.ui, ctx.tools, ctx.permissions, prompt);
  void maybeGenerateTitle(ctx.session, ctx.provider);
}

async function handleCommit(ctx: CommandContext): Promise<CommandOutcome> {
  await runPrompt(
    ctx,
    "Create a git commit for the current changes. First run `git status`, `git diff HEAD` and `git log -5 --oneline` to see what " +
      "changed and how this repo words its commit messages. Stage only files that belong to this change (never secrets or build " +
      "artifacts), then commit with a message in the repo's own style that explains why, not just what. Do not push." +
      (ctx.args.trim() ? `\n\nExtra guidance from the user: ${ctx.args.trim()}` : ""),
  );
  return "continue";
}

async function handleCommitPushPr(ctx: CommandContext): Promise<CommandOutcome> {
  await runPrompt(
    ctx,
    "Ship the current changes as a pull request. Steps: (1) if you are on the default branch, create a descriptively named " +
      "branch; (2) commit the relevant changes in the repo's message style (never secrets or build artifacts); (3) push the branch " +
      "with upstream tracking; (4) open a pull request with `gh pr create`, with a title and a body that summarizes the change and " +
      "how it was tested. Stop and report if any step fails, do not force-push or work around a failure." +
      (ctx.args.trim() ? `\n\nExtra guidance from the user: ${ctx.args.trim()}` : ""),
  );
  return "continue";
}

async function handleFeatureDev(ctx: CommandContext): Promise<CommandOutcome> {
  const feature = ctx.args.trim();
  if (!feature) {
    ctx.ui.writeError("Usage: /feature-dev <description of the feature to build>");
    return "continue";
  }
  await runPrompt(
    ctx,
    `Build this feature, in stages: ${feature}\n\n` +
      "1. Explore: delegate to the `code-explorer` subagent (task tool) to map the code this feature touches and the conventions around it.\n" +
      "2. Clarify: if the request is ambiguous in a way that changes the design, ask the user your questions now and wait for the answers.\n" +
      "3. Design: delegate to the `code-architect` subagent for an implementation plan that fits the existing patterns, and present it " +
      "to the user for approval before writing code.\n" +
      "4. Implement: make the changes and add tests, following the approved plan.\n" +
      "5. Review: delegate to the `code-reviewer` subagent on your own diff, fix what is real, and report the final state.",
  );
  return "continue";
}

const DEFAULT_RALPH_MAX = 10;
const HARD_RALPH_MAX = 50;

function lastAssistantText(ctx: CommandContext): string {
  for (let i = ctx.session.messages.length - 1; i >= 0; i--) {
    const m = ctx.session.messages[i];
    if (m.role === "assistant") return m.content ?? "";
  }
  return "";
}

/** /ralph-loop [--max N] [--until WORD] <task> — re-runs the same task until the agent declares it done or the cap is hit. */
async function handleRalphLoop(ctx: CommandContext): Promise<CommandOutcome> {
  let rest = ctx.args.trim();
  let max = DEFAULT_RALPH_MAX;
  let promise = "DONE";
  for (;;) {
    const maxMatch = /^--max\s+(\d+)\s*/.exec(rest);
    const untilMatch = /^--until\s+(\S+)\s*/.exec(rest);
    if (maxMatch) {
      max = Math.min(Math.max(Number(maxMatch[1]), 1), HARD_RALPH_MAX);
      rest = rest.slice(maxMatch[0].length);
    } else if (untilMatch) {
      promise = untilMatch[1];
      rest = rest.slice(untilMatch[0].length);
    } else break;
  }
  if (!rest) {
    ctx.ui.writeError(`Usage: /ralph-loop [--max N] [--until WORD] <task> (default max ${DEFAULT_RALPH_MAX}, hard cap ${HARD_RALPH_MAX}; stops when the agent answers <promise>WORD</promise>)`);
    return "continue";
  }

  const prompt =
    `${rest}\n\nYou are in an iterative loop: the same task is handed back to you after each attempt, and you can see your earlier work in the files and in this conversation. ` +
    `Improve on it each time. Only when the task is genuinely complete and verified, end your reply with <promise>${promise}</promise>, never say it to escape the loop.`;
  const marker = `<promise>${promise}</promise>`;

  for (let i = 1; i <= max; i++) {
    ctx.ui.writeSystem(`(ralph-loop: iteration ${i}/${max})`);
    const before = ctx.session.messages.length;
    await runPrompt(ctx, prompt);
    // A turn that produced nothing (aborted, errored, blocked by a hook) ends the loop rather than spinning.
    if (ctx.session.messages.length === before) {
      ctx.ui.writeSystem("(ralph-loop: stopped, the last iteration produced no response)");
      return "continue";
    }
    if (lastAssistantText(ctx).includes(marker)) {
      ctx.ui.writeSystem(`(ralph-loop: finished after ${i} iteration(s))`);
      return "continue";
    }
  }
  ctx.ui.writeSystem(`(ralph-loop: stopped at the ${max}-iteration cap without a completion promise)`);
  return "continue";
}

function handleOutputStyle(ctx: CommandContext): CommandOutcome {
  const name = ctx.args.trim();
  if (!name) {
    const current = ctx.session.outputStyle ?? "default";
    ctx.ui.writeSystem(`Output style: ${current}\n${OUTPUT_STYLES.map((s) => `  ${s.name}, ${s.description}`).join("\n")}\nSwitch with /output-style <name>.`);
    return "continue";
  }
  const style = findOutputStyle(name);
  if (!style) {
    ctx.ui.writeError(`Unknown output style "${name}". Available: ${OUTPUT_STYLES.map((s) => s.name).join(", ")}.`);
    return "continue";
  }
  ctx.session.outputStyle = style.name === "default" ? undefined : style.name;
  ctx.ui.writeSystem(`Output style set to ${style.name}, applies from the next message.`);
  return "continue";
}

export function registerWorkflowCommands(commands: CommandRegistry): void {
  commands.register("commit", handleCommit, "Commit the current changes with a message in this repo's style (no push): /commit [guidance]");
  commands.register("commit-push-pr", handleCommitPushPr, "Branch if needed, commit, push and open a pull request with gh: /commit-push-pr [guidance]");
  commands.register("feature-dev", handleFeatureDev, "Guided feature development: explore, clarify, design, implement, review: /feature-dev <feature>");
  commands.register("ralph-loop", handleRalphLoop, "Re-run a task until the agent declares it done: /ralph-loop [--max N] [--until WORD] <task>");
  commands.register("output-style", handleOutputStyle, "Show or change how the agent communicates: /output-style [default|explanatory|learning]");
}
