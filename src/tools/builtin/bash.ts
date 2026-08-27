import { spawn } from "node:child_process";
import type { ToolDefinition } from "../../core/types.js";
import { killProcessGroup } from "../../util/process.js";

interface BashInput {
  command: string;
  timeout_ms?: number;
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 100_000; // bytes per stream

function truncate(s: string): string {
  return s.length > MAX_BUFFER ? `${s.slice(0, MAX_BUFFER)}\n... (truncated)` : s;
}

/** First whitespace-separated token of the command, used as the permission risk key. */
function commandPrefix(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? command;
}

export const bashTool: ToolDefinition<BashInput> = {
  name: "bash",
  description:
    "Run a shell command in the project directory and capture its output. Each call is a fresh " +
    "non-interactive shell — job control (`kill %1`, `fg`, `bg`) doesn't work; to stop a process you " +
    "started earlier, use its actual PID (capture it with `cmd & echo $!`, or a pidfile) or `pkill -f pattern`. " +
    "When backgrounding a long-running process (a dev server, a watcher), redirect its output " +
    "(`cmd > /tmp/out.log 2>&1 &`) — otherwise the orphaned process keeps the pipe open and this call " +
    "won't return until the timeout.",
  riskLevel: "dangerous",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 120000)" },
      cwd: { type: "string", description: "Working directory, relative to the project root" },
    },
    required: ["command"],
  },
  riskKey: (input) => commandPrefix(input.command),
  describeCall: (input) => input.command,
  async handler(input, ctx) {
    const cwd = input.cwd ? `${ctx.cwd}/${input.cwd}` : ctx.cwd;
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve) => {
      // detached: true makes the shell its own process group leader, so a
      // command that backgrounds something (`server &`) without redirecting
      // its output can be reaped as a whole group on timeout — otherwise
      // that orphaned process keeps holding the inherited stdout/stderr pipe
      // open, and Node's "close" event (and this whole call) never fires,
      // even after killing just the immediate shell process.
      const child = spawn(input.command, { cwd, shell: true, signal: ctx.signal, detached: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child);
      }, timeoutMs);

      child.stdout?.on("data", (d) => (stdout += d));
      child.stderr?.on("data", (d) => (stderr += d));

      child.on("close", (code) => {
        clearTimeout(timer);
        const header = timedOut
          ? `(timed out after ${timeoutMs}ms)\n`
          : `(exit code ${code})\n`;
        const content = `${header}--- stdout ---\n${truncate(stdout)}\n--- stderr ---\n${truncate(stderr)}`;
        resolve({ content, isError: timedOut || code !== 0 });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ content: `Failed to start command: ${err.message}`, isError: true });
      });
    });
  },
};
