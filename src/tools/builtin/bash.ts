import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

interface BashInput {
  command: string;
  timeout_ms?: number;
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

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
    return runSubprocess(input.command, { cwd, timeoutMs, signal: ctx.signal });
  },
};
