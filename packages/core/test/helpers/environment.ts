import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { chromium } from "playwright-core";

// Several suites exercise real external tools (Chromium, docker, bubblewrap,
// pdftoppm, ...) or the real network. CI installs all of them, so a missing
// one there is a genuine failure and must stay one. On a developer machine
// that simply lacks a tool, the same suite is skipped instead of failing with
// an error that says nothing about the code under test.
//
//   describe.skipIf(skipLocally(hasCommand("pdftoppm")))("pdf tools", () => { ... });
//
// `skipLocally(available)` is true only when the dependency is missing AND we
// are not in CI (the `CI` env var, set by GitHub Actions and most CI systems).

export const IN_CI = Boolean(process.env.CI);

/** True when the dependency is missing and we're allowed to skip (i.e. not in CI). */
export function skipLocally(available: boolean): boolean {
  return !available && !IN_CI;
}

/** True when `name` resolves to an executable on PATH. */
export function hasCommand(name: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [name], { stdio: "ignore" }).status === 0;
}

/** True when Playwright's Chromium binary is installed. */
export function hasChromium(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** True on Linux, where bubblewrap (the OS sandbox) can exist at all. */
export const isLinux = process.platform === "linux";

/** True when a DNS lookup of a well-known host succeeds within `timeoutMs`. Use with top-level await. */
export async function isOnline(host = "example.com", timeoutMs = 2000): Promise<boolean> {
  try {
    await Promise.race([lookup(host), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))]);
    return true;
  } catch {
    return false;
  }
}

/** True when `docker info` succeeds (a running daemon, not just the CLI). */
export function hasDockerDaemon(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 5000 }).status === 0;
}
