import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { ToolDefinition } from "../../core/types.js";

// Native cron scheduling, inspired by Hermes Agent's own cron feature and
// OpenHands' Automation Server: lets the agent schedule ITSELF to run a
// given prompt again later, unattended, via the real per-user crontab
// (`crontab -l`/`crontab -`) — no daemon of this project's own to build
// or keep running, cron already is one.
//
// The scheduled command re-invokes this same CLI in the new --prompt/
// --cwd single-shot mode added alongside this tool (cli.ts: runs one
// turn non-interactively and exits, instead of starting the REPL — cron
// has no TTY to drive a REPL with anyway), with --non-interactive so an
// unattended run can't get stuck waiting on a permission prompt nobody
// is there to answer.
//
// Disclosed scope reduction vs a natural-language scheduler: this takes
// a raw 5-field cron expression (e.g. "0 9 * * *"), not "every day at
// 9am" parsed for you — building a real NL-to-cron parser is a separate
//, sizable piece of scope; the model itself is generally quite capable
// of writing a correct cron expression when asked to, so this isn't a
// hard blocker in practice.
//
// riskLevel "dangerous": this modifies the user's REAL system crontab
// and creates genuinely unattended, recurring agent executions — the
// single most consequential scheduling primitive on the machine.
const TAG_PREFIX = "# finanfa-code-task:";

export interface SchedulerDeps {
  /** Command + args used to invoke crontab (default ["crontab"]) — overridable so tests can point this at a fake crontab implementation instead of ever touching the real system crontab. */
  crontabCommand?: string[];
}

function runCrontab(args: string[], stdin: string | undefined, crontabCommand: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const [cmd, ...baseArgs] = crontabCommand;
    const child = spawn(cmd!, [...baseArgs, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: -1 }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/** Reads the current crontab, tolerating "no crontab for user" (a real, expected condition on a machine with none configured yet, not an error). */
async function readCrontab(crontabCommand: string[]): Promise<string> {
  const { stdout, stderr, code } = await runCrontab(["-l"], undefined, crontabCommand);
  if (code === 0) return stdout;
  if (/no crontab for/i.test(stderr)) return "";
  throw new Error(`Failed to read crontab: ${stderr || `exit code ${code}`}`);
}

async function writeCrontab(content: string, crontabCommand: string[]): Promise<void> {
  const { stderr, code } = await runCrontab([], content, crontabCommand);
  if (code !== 0) throw new Error(`Failed to write crontab: ${stderr || `exit code ${code}`}`);
}

interface ScheduledTask {
  id: string;
  cronExpression: string;
  prompt: string;
  cwd: string;
  label?: string;
}

// Loose validation (not a full semantic cron parser): a field may combine
// digits, commas (lists), hyphens (ranges), and step syntax on either a
// number or a bare "*" (e.g. "*/15", "1-5", "0,15,30,45") — this caught a
// real bug in an earlier, stricter version of this regex that rejected
// "*/15" (a very common, valid expression: every 15 minutes) outright.
const CRON_FIELD_RE = /^[0-9*,\-/]+$/;
function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => CRON_FIELD_RE.test(f));
}

function buildCommand(cwd: string, prompt: string): string {
  // Re-invokes however THIS process is actually being run right now
  // (node + whatever script path is currently executing) — correctly
  // reflects a global npm-linked bin, a local dev tsx run, or the built
  // dist/finanfa.js, rather than guessing/hardcoding a path that might
  // not match the real deployment.
  const nodeBin = process.execPath;
  const scriptPath = process.argv[1] ?? "finanfa";
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const escapedCwd = cwd.replace(/'/g, "'\\''");
  return `${nodeBin} ${scriptPath} --cwd '${escapedCwd}' --prompt '${escapedPrompt}' --non-interactive --ui readline`;
}

function parseTaggedLines(crontab: string): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];
  for (const line of crontab.split("\n")) {
    const tagIndex = line.indexOf(TAG_PREFIX);
    if (tagIndex === -1) continue;
    try {
      const json = line.slice(tagIndex + TAG_PREFIX.length).trim();
      const meta = JSON.parse(json) as { id: string; label?: string; prompt: string; cwd: string };
      const cronExpression = line.slice(0, tagIndex).split(/\s+/).slice(0, 5).join(" ").trim();
      tasks.push({ id: meta.id, cronExpression, prompt: meta.prompt, cwd: meta.cwd, label: meta.label });
    } catch {
      continue;
    }
  }
  return tasks;
}

function buildCrontabLine(task: ScheduledTask): string {
  const meta = JSON.stringify({ id: task.id, label: task.label, prompt: task.prompt, cwd: task.cwd });
  const command = buildCommand(task.cwd, task.prompt);
  return `${task.cronExpression} ${command} >> ${task.cwd}/.finanfa-code/cron.log 2>&1 ${TAG_PREFIX}${meta}`;
}

interface ScheduleTaskInput {
  cronExpression: string;
  prompt: string;
  label?: string;
}

interface UnscheduleTaskInput {
  taskId: string;
}

export function createSchedulerTools(deps: SchedulerDeps = {}): ToolDefinition[] {
  const crontabCommand = deps.crontabCommand ?? ["crontab"];

  const scheduleTask: ToolDefinition<ScheduleTaskInput> = {
    name: "schedule_task",
    description:
      "Schedule this agent to run a given prompt again later, unattended, via the user's real system crontab " +
      "(standard 5-field cron expression, e.g. '0 9 * * *' for daily at 9am, '*/15 * * * *' for every 15 " +
      "minutes). The scheduled run happens non-interactively (any tool call needing approval is auto-denied) " +
      "in the CURRENT project directory, with output appended to .finanfa-code/cron.log. " +
      "IMPORTANT: this modifies the user's real system crontab and creates a genuinely recurring, unattended " +
      "execution — confirm the schedule and prompt with the user before calling this, and prefer scheduling " +
      "narrow, well-defined prompts (e.g. 'run the test suite and report failures') over open-ended ones for " +
      "an unattended run.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        cronExpression: { type: "string", description: "Standard 5-field cron expression (minute hour day-of-month month day-of-week)" },
        prompt: { type: "string", description: "The prompt to run at each scheduled time" },
        label: { type: "string", description: "Optional short label for this task, shown in list_scheduled_tasks" },
      },
      required: ["cronExpression", "prompt"],
    },
    describeCall: (input) => `schedule "${input.prompt.slice(0, 60)}" at "${input.cronExpression}"`,
    async handler(input, ctx) {
      if (!isValidCronExpression(input.cronExpression)) {
        return { content: `"${input.cronExpression}" is not a valid 5-field cron expression (minute hour day-of-month month day-of-week).`, isError: true };
      }
      const task: ScheduledTask = { id: randomBytes(6).toString("hex"), cronExpression: input.cronExpression, prompt: input.prompt, cwd: ctx.cwd, label: input.label };
      try {
        const current = await readCrontab(crontabCommand);
        const updated = `${current.trimEnd()}\n${buildCrontabLine(task)}\n`;
        await writeCrontab(updated, crontabCommand);
        return { content: `Scheduled task ${task.id}: "${input.prompt}" at "${input.cronExpression}" in ${ctx.cwd}.`, isError: false };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };

  const listScheduledTasks: ToolDefinition<Record<string, never>> = {
    name: "list_scheduled_tasks",
    description: "List every task this agent has scheduled via schedule_task, across all projects, with their id/cron expression/prompt/directory.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    describeCall: () => "list scheduled tasks",
    async handler() {
      try {
        const tasks = parseTaggedLines(await readCrontab(crontabCommand));
        if (tasks.length === 0) return { content: "No tasks currently scheduled.", isError: false };
        const lines = tasks.map((t) => `${t.id}${t.label ? ` (${t.label})` : ""}: "${t.cronExpression}" -> "${t.prompt}" in ${t.cwd}`);
        return { content: lines.join("\n"), isError: false };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };

  const unscheduleTask: ToolDefinition<UnscheduleTaskInput> = {
    name: "unschedule_task",
    description: "Remove a task previously scheduled via schedule_task, by its task id (see list_scheduled_tasks). Modifies the user's real system crontab.",
    riskLevel: "ask",
    inputSchema: { type: "object", properties: { taskId: { type: "string", description: "Task id from list_scheduled_tasks" } }, required: ["taskId"] },
    describeCall: (input) => `unschedule task ${input.taskId}`,
    async handler(input) {
      try {
        const current = await readCrontab(crontabCommand);
        const lines = current.split("\n");
        const kept = lines.filter((line) => !(line.includes(TAG_PREFIX) && line.includes(`"id":"${input.taskId}"`)));
        if (kept.length === lines.length) return { content: `No scheduled task found with id "${input.taskId}".`, isError: true };
        await writeCrontab(`${kept.join("\n").trimEnd()}\n`, crontabCommand);
        return { content: `Removed scheduled task ${input.taskId}.`, isError: false };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };

  return [scheduleTask, listScheduledTasks, unscheduleTask];
}
