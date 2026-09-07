import { spawnSync } from "node:child_process";

// Shared "is this external binary actually installed?" check — used to
// decide whether to register a tool that wraps an optional external CLI
// (run_mydevops, run_esptool, run_avrdude, ...) at all, rather than
// always registering it and letting the model discover at call time that
// the person never installed the underlying tool. Checked once per
// command name and cached (spawning a real process per check is real,
// if cheap, I/O — no reason to repeat it on every registerBuiltins call
// within the same process).
const cache = new Map<string, boolean>();

/** Spawns `command` with no args (stdio ignored, so a CLI that prints usage/help on no args can't hang waiting on stdin) and checks whether the OS could find it at all — an ENOENT means "not installed"; any other outcome (including a non-zero exit code from a CLI that requires args) means the binary is genuinely present. */
export function isCommandAvailable(command: string): boolean {
  const cached = cache.get(command);
  if (cached !== undefined) return cached;

  let available: boolean;
  try {
    const result = spawnSync(command, [], { stdio: "ignore", timeout: 5_000 });
    available = !result.error || (result.error as NodeJS.ErrnoException).code !== "ENOENT";
  } catch {
    available = false;
  }
  cache.set(command, available);
  return available;
}

/** Test-only: clears the cache so tests can exercise both branches. */
export function resetCommandAvailabilityCacheForTests(): void {
  cache.clear();
}
