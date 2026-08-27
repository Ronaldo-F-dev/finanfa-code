import type { ChildProcess } from "node:child_process";

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
