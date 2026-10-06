import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// OS-level sandboxing for the `bash` tool, via bubblewrap (bwrap) on Linux —
// the same unprivileged-user-namespace sandbox Flatpak and (per its own
// docs) Open Interpreter use. Without this, `bash` (riskLevel "dangerous")
// is protected only by the permission-prompt layer: once a command is
// approved, it runs directly on the host with the user's full filesystem
// access. This adds a real technical barrier underneath that prompt.
//
// "workspace-write" is the only mode implemented: read-only bind of the
// entire filesystem, read-write only for the command's own cwd plus a
// curated set of dev-tool cache/config directories (skipped if they don't
// exist) that legitimate workflows commonly need to write to outside the
// project (npm/pip/cargo caches, ~/.gitconfig, ~/.ssh/known_hosts).
// Network stays shared — blocking it would break npm install/git push/curl,
// which are far more common than the exfiltration risk this is meant to
// catch. This is a real, meaningful improvement (protects the rest of the
// filesystem — other projects, system files, other users' data) but is NOT
// hardened against a command that tampers with the user's own dotfiles/
// caches, and does nothing on non-Linux platforms (bwrap doesn't exist
// there) — both limitations are deliberate scope choices, not oversights.
export type SandboxMode = "off" | "workspace-write";

export interface SandboxConfig {
  mode?: SandboxMode;
  /** Additional host paths to mount read-write inside the sandbox, beyond DEFAULT_EXTRA_WRITABLE_PATHS. Skipped silently if a path doesn't exist. */
  extraWritablePaths?: string[];
  /**
   * "allow" (default, today's behavior): the sandboxed command shares the host network.
   * "deny": it runs in its own empty network namespace (no interfaces beyond loopback), so
   * nothing can be fetched or exfiltrated — at the price of breaking npm install/git push/curl
   * inside `bash`. All-or-nothing: a per-domain allow-list would need a filtering proxy.
   */
  network?: "allow" | "deny";
}

export const DEFAULT_EXTRA_WRITABLE_PATHS: string[] = [
  path.join(os.homedir(), ".cache"),
  path.join(os.homedir(), ".npm"),
  path.join(os.homedir(), ".cargo"),
  path.join(os.homedir(), ".config"),
  path.join(os.homedir(), ".local"),
  path.join(os.homedir(), ".ssh"),
];

let bwrapAvailable: boolean | undefined;

/** Checked once per process and cached — spawnSync on every bash call would be wasteful, and availability can't change mid-run. */
export function isBwrapAvailable(): boolean {
  if (bwrapAvailable !== undefined) return bwrapAvailable;
  if (process.platform !== "linux") {
    bwrapAvailable = false;
    return false;
  }
  try {
    const result = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
    bwrapAvailable = result.status === 0;
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
}

/** Test-only: clears the cached availability check so tests can exercise both branches (e.g. by manipulating PATH). */
export function resetBwrapAvailabilityCacheForTests(): void {
  bwrapAvailable = undefined;
}

/**
 * Builds the `bwrap` argv (everything before `--` and the real command) for
 * a workspace-write sandbox rooted at `cwd`. `/tmp` is bound (not tmpfs) so
 * behavior across separate `bash` calls in the same session stays close to
 * today's unsandboxed behavior (a file written to /tmp in one call is still
 * readable in a later one).
 */
export function buildBwrapArgs(cwd: string, extraWritablePaths: string[] = DEFAULT_EXTRA_WRITABLE_PATHS, network: "allow" | "deny" = "allow"): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", "/tmp", "/tmp", "--bind", cwd, cwd, "--die-with-parent"];
  for (const p of extraWritablePaths) args.push("--bind-try", p, p);
  if (network === "deny") args.push("--unshare-net");
  return args;
}

export function shouldSandbox(sandbox: SandboxConfig | undefined): boolean {
  return sandbox?.mode === "workspace-write" && isBwrapAvailable();
}
