import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { runTurn, maybeGenerateTitle } from "../core/loop.js";
import type { CommandContext, CommandOutcome } from "./types.js";

// Real Claude Code's custom slash commands: a markdown file becomes a
// user-invokable `/<name>` shortcut that expands to a prompt template and
// runs through the real agent loop — distinct from a skill (loaded
// on-demand by the model itself via read_skill, never runs a turn by
// itself) and from a builtin command (a fixed, synchronous, code-defined
// action like /cost or /clear, never talks to the model at all).
export type CustomCommandScope = "project" | "global";

export interface CustomCommand {
  name: string;
  description: string;
  /** The prompt template. $ARGUMENTS is replaced with whatever follows the command name; if the template doesn't mention it, the raw args (if any) are appended instead. */
  content: string;
  scope: CustomCommandScope;
}

/** ~/.finanfa-code/commands — computed fresh per call, not memoized (a test overriding $HOME must see it). */
export function globalCommandsDir(): string {
  return path.join(os.homedir(), ".finanfa-code", "commands");
}

export function projectCommandsDir(cwd: string): string {
  return path.join(cwd, ".finanfa-code", "commands");
}

async function readCommandsFromDir(dir: string, scope: CustomCommandScope): Promise<CustomCommand[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const result: CustomCommand[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = await readFile(filePath, "utf-8");
      const { data, content } = matter(raw);
      result.push({
        name: typeof data.name === "string" ? data.name : entry.replace(/\.md$/, ""),
        description: typeof data.description === "string" ? data.description : "",
        content: content.trim(),
        scope,
      });
    } catch (err) {
      // Same convention as skills/loader.ts: one bad file (malformed
      // frontmatter, a directory named *.md, a permission error) shouldn't
      // take down the whole CLI at startup.
      console.error(`Warning: failed to read custom command ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** Project-local commands (.finanfa-code/commands) win over global (~/.finanfa-code/commands) ones with the same name — same precedence as skills. */
export async function loadCustomCommands(cwd: string): Promise<Map<string, CustomCommand>> {
  const [global, project] = await Promise.all([
    readCommandsFromDir(globalCommandsDir(), "global"),
    readCommandsFromDir(projectCommandsDir(cwd), "project"),
  ]);
  const byName = new Map(global.map((c) => [c.name, c]));
  for (const c of project) byName.set(c.name, c);
  return byName;
}

export function expandCustomCommand(command: CustomCommand, args: string): string {
  if (command.content.includes("$ARGUMENTS")) return command.content.replaceAll("$ARGUMENTS", args);
  return args ? `${command.content}\n\n${args}` : command.content;
}

/**
 * Runs a custom command through the real agent loop — same as if the user
 * had typed the expanded template themselves — rather than as a
 * synchronous, purely-local CommandHandler the way builtins work.
 */
export async function runCustomCommand(ctx: CommandContext, command: CustomCommand): Promise<CommandOutcome> {
  const expanded = expandCustomCommand(command, ctx.args);
  await runTurn(ctx.session, ctx.provider, ctx.ui, ctx.tools, ctx.permissions, expanded);
  // Not awaited — same real reported bug as the CLI repl()'s own turn
  // handling: a second, invisible provider call (no busy indicator) that
  // callers have no reason to block their next prompt on. Best-effort and
  // self-persisting on success — see its own docstring.
  void maybeGenerateTitle(ctx.session, ctx.provider);
  return "continue";
}
