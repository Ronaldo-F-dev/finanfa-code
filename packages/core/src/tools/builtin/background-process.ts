import path from "node:path";
import os from "node:os";
import type { ToolDefinition } from "../../core/types.js";
import type { BackgroundProcessManager } from "../../core/background-process.js";
import { resolveAllowedPath } from "./path-guard.js";

function resolveCwd(projectCwd: string, target: string | undefined): string {
  return target ? resolveAllowedPath(projectCwd, target) : projectCwd;
}

/**
 * Tools for tracking long-running background processes (dev servers,
 * watchers) by name, instead of the model improvising `nohup`/`setsid`/
 * `pkill -f <guess>` with `bash` — the exact pattern that repeatedly went
 * wrong in real sessions (wrong process killed, an orphaned server left
 * holding a port, a stale log file read after the real process had already
 * died in a way that wasn't obvious from the shell output alone).
 */
export function createBackgroundProcessTools(manager: BackgroundProcessManager): ToolDefinition[] {
  const start: ToolDefinition<{ name: string; command: string; cwd?: string }> = {
    name: "start_background_process",
    description:
      "Start a long-running process (a dev server, a watcher) in the background, tracked under a name so it " +
      "can be listed or stopped later with list_background_processes/stop_background_process. Output is " +
      "redirected to a log file automatically — don't add your own trailing '&', redirection, nohup, or " +
      "setsid; this tool already handles all of that. Prefer this over plain bash for anything meant to keep " +
      "running after the command returns.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'A short identifier for this process, e.g. "flask-dev-server"' },
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string", description: "Working directory — absolute path, or relative to the project root" },
      },
      required: ["name", "command"],
    },
    riskKey: (input) => input.name,
    describeCall: (input) => `start "${input.name}": ${input.command}`,
    async handler(input, ctx) {
      const cwd = resolveCwd(ctx.cwd, input.cwd);
      const logFile = path.join(os.tmpdir(), `finanfa-bg-${input.name}-${randomSuffix()}.log`);
      try {
        const info = manager.start(input.name, input.command, cwd, logFile);
        return {
          content: `Started "${info.name}" (PID ${info.pid}) in ${info.cwd}. Output logged to ${info.logFile}.`,
          isError: false,
        };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };

  const list: ToolDefinition<Record<string, never>> = {
    name: "list_background_processes",
    description:
      "List background processes started via start_background_process in this session, with their PID, " +
      "whether still running, and log file path. Only knows about this session — a process from an earlier " +
      "finanfa-code run isn't tracked here even if it's still running.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    describeCall: () => "list background processes",
    async handler() {
      const processes = manager.list();
      if (processes.length === 0) {
        return { content: "No background processes started this session.", isError: false };
      }
      const lines = processes.map(
        (p) =>
          `${p.name} — PID ${p.pid} (${manager.isAlive(p.pid) ? "running" : "exited"}) — ${p.command} — ` +
          `started ${p.startedAt} — log: ${p.logFile}`,
      );
      return { content: lines.join("\n"), isError: false };
    },
  };

  const stop: ToolDefinition<{ name: string }> = {
    name: "stop_background_process",
    description: "Stop a background process started via start_background_process, by its name.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    riskKey: (input) => input.name,
    describeCall: (input) => `stop "${input.name}"`,
    async handler(input) {
      const stopped = manager.stop(input.name);
      return {
        content: stopped
          ? `Stopped "${input.name}".`
          : `No tracked background process named "${input.name}" (check list_background_processes).`,
        isError: !stopped,
      };
    },
  };

  return [start, list, stop];
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
