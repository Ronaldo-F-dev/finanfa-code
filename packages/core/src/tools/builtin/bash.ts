import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";
import { isBwrapAvailable, type SandboxConfig } from "../../util/sandbox.js";

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

/**
 * Factory (not a static export) so the sandbox config loaded once at
 * startup (see core/config.ts's `sandbox` field) can be closed over here.
 * Defaults to `{mode: "workspace-write"}` when the caller passes nothing —
 * i.e. sandboxed-if-bwrap-is-available is this tool's actual default, not
 * an opt-in; set `sandbox: {mode: "off"}` in .finanfa-code/config.json to
 * restore the old unsandboxed-by-default behavior. Silently unsandboxed on
 * non-Linux or when bwrap isn't installed either way — this must never be
 * a hard requirement, since bash is this project's single most load-
 * bearing tool.
 */
export function createBashTool(sandboxConfig?: SandboxConfig): ToolDefinition<BashInput> {
  const sandbox = sandboxConfig ?? { mode: "workspace-write" };
  const sandboxed = sandbox.mode === "workspace-write" && isBwrapAvailable();

  return {
    name: "bash",
    description:
      "Run a shell command in the project directory and capture its output. Each call is a fresh " +
      "non-interactive shell — job control (`kill %1`, `fg`, `bg`) doesn't work; to stop a process you " +
      "started earlier, use its actual PID (capture it with `cmd & echo $!`, or a pidfile) or `pkill -f pattern`. " +
      "When backgrounding a long-running process (a dev server, a watcher), redirect its output " +
      "(`cmd > /tmp/out.log 2>&1 &`) — otherwise the orphaned process keeps the pipe open and this call " +
      "won't return until the timeout." +
      (sandboxed
        ? " Runs inside an OS-level sandbox (bubblewrap): the rest of the filesystem is read-only, writes are " +
          "confined to this project's directory plus standard dev-tool cache dirs (~/.npm, ~/.cache, etc.) — a " +
          "command that tries to write or delete outside those will fail with a read-only-filesystem error, " +
          "that's expected, not a bug. Network access still works normally."
        : ""),
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
      return runSubprocess(input.command, { cwd, sessionId: ctx.sessionId, timeoutMs, signal: ctx.signal, sandbox });
    },
  };
}
