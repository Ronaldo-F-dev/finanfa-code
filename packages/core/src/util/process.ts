import { spawn, type ChildProcess } from "node:child_process";
import { truncateOrSpill, TRUNCATE_LARGE } from "./truncate.js";

/**
 * Shell to use for spawn's `shell` option. `shell: true` alone uses the OS
 * default — on Linux that's usually `/bin/sh`, which on Debian/Ubuntu is
 * `dash`, not bash: no brace expansion (`{a,b,c}`), no `[[ ]]`, no arrays.
 * A tool literally named "bash" (and a model that reasonably assumes bash
 * syntax works) should actually run bash. `true` still means the platform
 * default on Windows, where `/bin/bash` doesn't exist unless WSL/git-bash is
 * separately set up.
 */
export const SHELL: string | boolean = process.platform === "win32" ? true : "/bin/bash";

/**
 * Kills a child spawned with `detached: true` along with its entire process
 * group — not just the immediate process — so a backgrounded grandchild
 * (e.g. a dev server started with `command &` inside a script, without
 * redirecting its output) doesn't survive and keep an inherited stdio pipe
 * open forever, which would otherwise stop the parent's "close" event (and
 * whatever awaits it) from ever firing. Falls back to killing just the
 * immediate process if group-kill isn't available (e.g. on Windows, where
 * process groups work differently, or the process already exited).
 */
export function killProcessGroup(child: ChildProcess): void {
  if (typeof child.pid !== "number") return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export interface RunSubprocessOptions {
  cwd: string;
  /** Used only to namespace spilled (overflow) output on disk — see truncateOrSpill. */
  sessionId: string;
  timeoutMs: number;
  /** Extra args, spawning as `spawn(command, args, {...})` instead of a raw shell string. */
  args?: string[];
  signal?: AbortSignal;
  /** Decide isError from the exit code (null if killed/never exited). Default: any nonzero code is an error. */
  isError?: (code: number | null) => boolean;
  /**
   * "labeled" (default, bash/run_tests style): always show both `--- stdout
   * ---`/`--- stderr ---` sections, even if empty. "compact" (check_python_types/
   * lint_javascript style): stdout unlabeled, stderr appended only if non-empty.
   */
  format?: "labeled" | "compact";
}

export interface RunSubprocessResult {
  content: string;
  isError: boolean;
}

/**
 * Shared spawn + timeout/kill + stdout/stderr accumulation + exit-code
 * formatting, extracted after the same ~35-40 lines were independently
 * copy-pasted (and drifted slightly) across bash.ts, run-tests.ts,
 * check-python-types.ts, and lint-javascript.ts.
 */
export function runSubprocess(command: string, opts: RunSubprocessOptions): Promise<RunSubprocessResult> {
  return new Promise((resolve) => {
    // detached: true — see killProcessGroup: a command that backgrounds
    // something without redirecting its output would otherwise hold the
    // stdio pipe open forever, past a plain kill of just the immediate
    // process.
    //
    // opts.signal is NOT passed to spawn()'s own `signal` option — Node's
    // built-in handling for that just calls child.kill(), the same
    // single-process kill killProcessGroup exists specifically to avoid (a
    // detached grandchild, e.g. a dev server backgrounded inside the
    // command, would survive). Instead, listen for the abort ourselves and
    // route it through the exact same killProcessGroup call the timeout
    // path already uses below.
    const child = opts.args
      ? spawn(command, opts.args, { cwd: opts.cwd, shell: SHELL, detached: true })
      : spawn(command, { cwd: opts.cwd, shell: SHELL, detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, opts.timeoutMs);

    const onAbort = () => {
      aborted = true;
      killProcessGroup(child);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      void (async () => {
        const header = aborted ? "(cancelled — user interrupted)\n" : timedOut ? `(timed out after ${opts.timeoutMs}ms)\n` : `(exit code ${code})\n`;
        let content: string;
        if (opts.format === "compact") {
          const stderrBlock = stderr ? `\n--- stderr ---\n${await truncateOrSpill(opts.cwd, opts.sessionId, "stderr", stderr, TRUNCATE_LARGE)}` : "";
          content = `${header}${await truncateOrSpill(opts.cwd, opts.sessionId, "stdout", stdout, TRUNCATE_LARGE)}${stderrBlock}`;
        } else {
          content =
            `${header}--- stdout ---\n${await truncateOrSpill(opts.cwd, opts.sessionId, "stdout", stdout, TRUNCATE_LARGE)}\n` +
            `--- stderr ---\n${await truncateOrSpill(opts.cwd, opts.sessionId, "stderr", stderr, TRUNCATE_LARGE)}`;
        }
        const isError = aborted || timedOut || (opts.isError ? opts.isError(code) : code !== 0);
        resolve({ content, isError });
      })();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ content: `Failed to start "${command}": ${err.message}`, isError: true });
    });
  });
}
