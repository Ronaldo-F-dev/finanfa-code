import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { runTurn, maybeGenerateTitle } from "../core/loop.js";
import { loadAllSubagentTypes } from "../agents/loader.js";
import { HOOK_EVENT_NAMES } from "../hooks/config.js";
import type { CommandContext, CommandOutcome } from "./types.js";
import type { CommandRegistry } from "./registry.js";
import { handlePlugin } from "./plugin.js";
import { registerWorkflowCommands } from "./workflows.js";

const execFileAsync = promisify(execFile);

const ISSUES_URL = "https://github.com/Ronaldo-F-dev/finanfa-code/issues";
/** Cap on diff text shown inline — a huge diff would flood the terminal/web timeline. */
const MAX_DIFF_CHARS = 20_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

/** Runs `prompt` through the real agent loop, like a custom command does. */
async function runPromptCommand(ctx: CommandContext, prompt: string): Promise<CommandOutcome> {
  await runTurn(ctx.session, ctx.provider, ctx.ui, ctx.tools, ctx.permissions, prompt);
  void maybeGenerateTitle(ctx.session, ctx.provider);
  return "continue";
}

function handleHooks(ctx: CommandContext): CommandOutcome {
  const config = ctx.permissions.getHooksConfig();
  const lines: string[] = [];
  for (const event of HOOK_EVENT_NAMES) {
    for (const matcher of config[event] ?? []) {
      const scope = matcher.matcher ? ` (matcher: ${matcher.matcher})` : "";
      for (const hook of matcher.hooks) {
        const what = hook.type === "command" ? hook.command : `[${hook.type}] ${hook.prompt.replace(/\s+/g, " ").slice(0, 80)}`;
        lines.push(`${event}${scope}: ${what}`);
      }
    }
  }
  ctx.ui.writeSystem(
    lines.length > 0
      ? `${lines.length} hook(s) configured:\n${lines.join("\n")}`
      : `No hooks configured. Add a "hooks" field to ~/.finanfa-code/config.json or .finanfa-code/settings.json, events: ${HOOK_EVENT_NAMES.join(", ")}.`,
  );
  return "continue";
}

function handleStatus(ctx: CommandContext): CommandOutcome {
  const status = ctx.ui.getStatus();
  const lines = [
    `session: ${ctx.session.id}`,
    `cwd: ${ctx.cwd}`,
    `model: ${ctx.session.model}`,
    `plan mode: ${ctx.session.planMode ? "on" : "off"}`,
    `tools: ${ctx.tools.list().length} registered, ${ctx.session.disabledTools.size} disabled`,
    `messages: ${ctx.session.messages.length}`,
    status ? `usage: ${status.tokens} tokens, $${status.costUsd.toFixed(4)}` : "usage: none recorded yet",
  ];
  ctx.ui.writeSystem(lines.join("\n"));
  return "continue";
}

async function handleDiff(ctx: CommandContext): Promise<CommandOutcome> {
  try {
    const stat = (await git(ctx.cwd, ["diff", "HEAD", "--stat"])).trim();
    const untracked = (await git(ctx.cwd, ["ls-files", "--others", "--exclude-standard"])).trim();
    if (!stat && !untracked) {
      ctx.ui.writeSystem("No uncommitted changes.");
      return "continue";
    }
    const verbose = ctx.args.trim() === "full";
    let body = stat;
    if (verbose) {
      const full = await git(ctx.cwd, ["diff", "HEAD"]);
      body = full.length > MAX_DIFF_CHARS ? `${full.slice(0, MAX_DIFF_CHARS)}\n… (truncated, ${full.length} chars total)` : full;
    }
    const extra = untracked ? `\n\nUntracked:\n${untracked}` : "";
    ctx.ui.writeSystem(`${body}${extra}${verbose ? "" : "\n\n(/diff full shows the complete patch)"}`);
  } catch (err) {
    ctx.ui.writeError(`/diff needs a git repository: ${err instanceof Error ? err.message : String(err)}`);
  }
  return "continue";
}

async function handleInit(ctx: CommandContext): Promise<CommandOutcome> {
  const file = path.join(ctx.cwd, "finanfa.md");
  let existing = false;
  try {
    await access(file);
    existing = true;
  } catch {
    // no file yet — the normal case
  }
  const prompt = existing
    ? "A finanfa.md already exists in this project. Read it, then explore the codebase and propose targeted improvements, add what's missing (build/test/lint commands, architecture, conventions) and fix what's stale. Edit the file in place."
    : "Explore this codebase and create a finanfa.md at the project root: the project's purpose, how to build/test/lint/run it, the high-level architecture and key directories, and any conventions a new contributor must follow. Keep it concise and specific to this repo, no generic advice.";
  return runPromptCommand(ctx, prompt);
}

async function handleReview(ctx: CommandContext): Promise<CommandOutcome> {
  const target = ctx.args.trim();
  const scope = target
    ? `Review the changes described by: ${target} (use git to inspect it).`
    : "Review the current uncommitted changes (git diff HEAD, plus untracked files).";
  return runPromptCommand(
    ctx,
    `${scope}\n\nLook for correctness bugs first, then security issues, missing tests, and unnecessary complexity. For each finding give the file and line, what is wrong, and a concrete failure scenario. Do not modify any files. If nothing is wrong, say so plainly.`,
  );
}

async function handleAgents(ctx: CommandContext): Promise<CommandOutcome> {
  const types = await loadAllSubagentTypes(ctx.cwd);
  if (types.length === 0) {
    ctx.ui.writeSystem("No custom subagent types. Add markdown files to .finanfa-code/agents/ (project) or ~/.finanfa-code/agents/ (global).");
    return "continue";
  }
  const lines = types.map((t) => `${t.name} [${t.scope}]${t.tools ? ` tools: ${t.tools.join(", ")}` : ""}${t.description ? `, ${t.description}` : ""}`);
  ctx.ui.writeSystem(`${types.length} subagent type(s):\n${lines.join("\n")}`);
  return "continue";
}

/** /tasks [stop <name>] — the background processes the agent started (dev servers, watchers), driven through the same tools the model uses. */
async function handleTasks(ctx: CommandContext): Promise<CommandOutcome> {
  const [sub, name] = ctx.args.trim().split(/\s+/).filter(Boolean);
  const toolCtx = { cwd: ctx.cwd, sessionId: ctx.session.id, signal: new AbortController().signal };
  if (sub === "stop") {
    const stop = ctx.tools.get("stop_background_process");
    if (!name || !stop) {
      ctx.ui.writeError(name ? "Background process tools are not available in this session." : "Usage: /tasks [stop <name>]");
      return "continue";
    }
    const result = await stop.handler({ name }, toolCtx);
    (result.isError ? ctx.ui.writeError : ctx.ui.writeSystem).call(ctx.ui, result.content);
    return "continue";
  }
  if (sub !== undefined) {
    ctx.ui.writeError("Usage: /tasks [stop <name>]");
    return "continue";
  }
  const list = ctx.tools.get("list_background_processes");
  if (!list) {
    ctx.ui.writeError("Background process tools are not available in this session.");
    return "continue";
  }
  ctx.ui.writeSystem((await list.handler({}, toolCtx)).content);
  return "continue";
}

async function handleBug(ctx: CommandContext): Promise<CommandOutcome> {
  let version = "unknown";
  try {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf-8")) as { version?: string };
    version = pkg.version ?? version;
  } catch {
    // diagnostics are best-effort
  }
  ctx.ui.writeSystem(
    [
      `Report a bug: ${ISSUES_URL}/new`,
      "Include these diagnostics (no conversation content is added):",
      `  core: ${version}`,
      `  node: ${process.version} on ${process.platform}/${process.arch}`,
      `  model: ${ctx.session.model}`,
      `  session: ${ctx.session.id}`,
    ].join("\n"),
  );
  return "continue";
}

export function registerExtraCommands(commands: CommandRegistry): void {
  registerWorkflowCommands(commands);
  commands.register("hooks", handleHooks, "List the configured hooks (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, SessionStart, SessionEnd, Notification, PreCompact)");
  commands.register("status", handleStatus, "Show session, model, working directory, plan mode, tool and usage state");
  commands.register("diff", handleDiff, "Show uncommitted changes: /diff (summary) or /diff full (complete patch)");
  commands.register("init", handleInit, "Create (or improve) finanfa.md, the project instructions file, by exploring the codebase");
  commands.register("review", handleReview, "Review uncommitted changes, or a given commit/branch/PR: /review [target], read-only");
  commands.register("agents", handleAgents, "List the custom subagent types available to the task tool");
  commands.register("plugin", handlePlugin, "Manage plugins and marketplaces: /plugin [list|search|install|remove|enable|disable|test|marketplace], run /plugin for usage");
  commands.register("tasks", handleTasks, "List the background processes the agent started, or stop one: /tasks [stop <name>]");
  commands.register("bug", handleBug, "Print the issue tracker link and diagnostics for a bug report");
}
