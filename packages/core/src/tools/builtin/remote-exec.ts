import { spawn } from "node:child_process";
import type { ToolDefinition } from "../../core/types.js";
import { killProcessGroup } from "../../util/process.js";

// Distributed remote-node command execution (node-host) — a real gap
// relative to a comparable project's own remote-node feature, which lets
// the agent run commands on a separate machine, not just the one it's
// running on. Wraps the user's own already-configured `ssh` (host
// aliases/keys/agent all come from their real ~/.ssh/config — this tool
// deliberately takes no credentials of its own, the same "wrap the real
// CLI, don't reimplement its auth" choice run_mydevops.ts and the
// 1Password/Vault tools already make) rather than a bespoke remote-
// execution protocol.
//
// Not runSubprocess: that helper always spawns through a real shell when
// given args (see process.ts), which re-tokenizes a joined command+args
// string — for a remote command containing `$(...)`, backticks, or
// quotes, that would let the LOCAL shell evaluate/mangle them before ssh
// ever sends anything, instead of the REMOTE shell seeing them intact
// (the same class of bug debug-python.ts/debug-node.ts hit and fixed by
// writing to a temp file — here the fix is simpler: don't go through a
// shell locally at all, since the remote command is meant to be
// interpreted by the *remote* shell, not the local one).
export interface SshResult {
  stdout: string;
  stderr: string;
  isError: boolean;
  /** ssh's own real exit code (null if it never even started, e.g. ENOENT) — 255 is ssh's documented code for "an error occurred" (couldn't connect/authenticate/etc.), distinct from the REMOTE command's own exit code passed through unchanged for everything else. See isRetryableSshFailure. */
  exitCode: number | null;
}

export function runSsh(binary: string, args: string[], timeoutMs: number): Promise<SshResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { detached: true }); // shell: false (the default) is the whole point here
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
      resolve({ stdout, stderr: timedOut ? `Timed out after ${timeoutMs}ms` : stderr, isError: timedOut || code !== 0, exitCode: timedOut ? null : code });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err.message, isError: true, exitCode: null });
    });
  });
}

/**
 * True only for a failure ssh itself reports BEFORE the remote command
 * ever ran (exit 255 — ssh's own documented code for "an error occurred":
 * couldn't connect, auth failed, DNS didn't resolve, etc. — see ssh(1)),
 * or a local timeout/spawn failure (never reached the remote side
 * either). Deliberately false for every other exit code: that means ssh
 * connected fine and the REMOTE command itself returned it, and retrying
 * a command that may have already partially run remotely risks running
 * it twice — a real hazard for anything non-idempotent (a deploy, a
 * write). This is the same signal real remote-automation tools (e.g.
 * Ansible) use to distinguish "never ran" from "ran and failed".
 */
export function isRetryableSshFailure(result: SshResult): boolean {
  return result.isError && (result.exitCode === 255 || result.exitCode === null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries runSsh up to `retries` extra times, but ONLY on a connection-level failure (see isRetryableSshFailure) — never after the remote command itself ran and returned a real exit code. Exponential backoff between attempts (baseDelayMs, doubling). */
export async function runSshWithRetry(binary: string, args: string[], timeoutMs: number, retries = 0, baseDelayMs = 500): Promise<SshResult> {
  let result = await runSsh(binary, args, timeoutMs);
  for (let attempt = 0; attempt < retries && isRetryableSshFailure(result); attempt++) {
    await sleep(baseDelayMs * 2 ** attempt);
    result = await runSsh(binary, args, timeoutMs);
  }
  return result;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export interface SshTarget {
  host: string;
  command: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/** Shared by run_remote_command and remote-hosts.ts's health check — the exact same real BatchMode/target/command argv shape either way. */
export function buildSshArgs(target: SshTarget): string[] {
  const args = ["-o", "BatchMode=yes"];
  if (target.port) args.push("-p", String(target.port));
  if (target.identityFile) args.push("-i", target.identityFile);
  args.push(target.user ? `${target.user}@${target.host}` : target.host, target.command);
  return args;
}

export interface RunRemoteCommandToolOptions {
  binary?: string;
}

interface RunRemoteCommandInput {
  host: string;
  command: string;
  user?: string;
  port?: number;
  identity_file?: string;
  timeout_ms?: number;
  retries?: number;
}

export function createRunRemoteCommandTool(options: RunRemoteCommandToolOptions = {}): ToolDefinition<RunRemoteCommandInput> {
  const binary = options.binary ?? "ssh";
  return {
    name: "run_remote_command",
    description:
      "Run a command on a separate, remote machine over SSH — `host` can be a real hostname/IP or an alias " +
      "already defined in the user's own ~/.ssh/config (auth/keys/known_hosts all come from their real SSH " +
      "setup; this tool never takes credentials as input). Runs non-interactively (BatchMode) — a host " +
      "requiring a password instead of key-based auth fails clearly rather than hanging. " +
      "IMPORTANT: this runs a real command on a real remote machine — confirm with the user before calling " +
      "this unless they've explicitly asked for this exact command.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Hostname, IP, or an alias from ~/.ssh/config" },
        command: { type: "string", description: "Command to run on the remote host — interpreted by the REMOTE shell, exactly as if typed after `ssh host`" },
        user: { type: "string", description: "Remote username, if not already implied by host/~/.ssh/config" },
        port: { type: "number", description: "SSH port, if not 22 and not already set in ~/.ssh/config" },
        identity_file: { type: "string", description: "Path to a specific private key, if not already resolved via ~/.ssh/config or ssh-agent" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 60000)" },
        retries: {
          type: "number",
          description:
            "Retry up to this many extra times (exponential backoff) on a transient CONNECTION failure — a network blip, host briefly unreachable, timeout. Never retries once the remote command itself actually ran and returned its own exit code, only a failure ssh reports before that (default 0 — off, matching the previous behavior). Only set this above 0 for a command safe to run more than once (idempotent) — a network drop that happens mid-command can't always be told apart from one before it started.",
        },
      },
      required: ["host", "command"],
    },
    riskKey: (input) => `remote:${input.host}`,
    describeCall: (input) => `ssh ${input.user ? `${input.user}@` : ""}${input.host}: ${input.command}`,
    async handler(input) {
      const args = buildSshArgs({ host: input.host, command: input.command, user: input.user, port: input.port, identityFile: input.identity_file });
      const result = await runSshWithRetry(binary, args, input.timeout_ms ?? DEFAULT_TIMEOUT_MS, input.retries ?? 0);
      const header = result.isError ? "(failed)\n" : "(exit code 0)\n";
      const content = `${header}--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
      return { content, isError: result.isError };
    },
  };
}
