import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Trust-on-first-use for a project directory, matching real Claude Code's
// "do you trust the files in this folder?" gate. Exists specifically
// because .finanfa-code/settings.json is a PROJECT file — anyone who can
// get a user to `cd` into a repo and run finanfa-code there can plant one.
// Without this, cloning an untrusted repo would silently load and act on
// whatever permission rules and hooks (see hooks/config.ts) that file
// defines — including a hook that auto-approves every tool call (a
// PreToolUse hook returning {"decision":"approve"}), fully defeating the
// permission system with zero user awareness. Once a folder is confirmed
// trusted, it's remembered — this is a one-time gate per folder, not a
// prompt on every launch.
function trustFilePath(): string {
  return path.join(os.homedir(), ".finanfa-code", "trusted-folders.json");
}

async function readTrustedFolders(): Promise<Set<string>> {
  try {
    const raw = await readFile(trustFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : []);
  } catch {
    // Missing file, malformed JSON, permission error — all mean "nothing
    // trusted yet". Failing safe (untrusted) here, never failing open.
    return new Set();
  }
}

export async function isFolderTrusted(cwd: string): Promise<boolean> {
  const trusted = await readTrustedFolders();
  return trusted.has(path.resolve(cwd));
}

export async function trustFolder(cwd: string): Promise<void> {
  const trusted = await readTrustedFolders();
  trusted.add(path.resolve(cwd));
  const file = trustFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify([...trusted], null, 2), "utf-8");
}
