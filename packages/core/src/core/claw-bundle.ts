import { readFile, writeFile, readdir, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

// "Claws" — versioned, installable bundles of a project's own
// finanfa-code configuration (permission rules/hooks, MCP servers,
// memory, skills, commands, agent types, path-scoped instructions,
// finanfa.md/finanfa-design.md), with provenance and rollback. A real
// gap relative to a comparable project's own bundle system, distinct
// from this project's existing plugins/ runtime (arbitrary imported JS,
// see docs/plugins.md) — a bundle is inert config+content, shareable as
// a single JSON file with no code execution risk of its own.
//
// Deliberately local-only: this covers the bundle FORMAT and install/
// rollback mechanism, not a hosted registry to discover/search bundles
// published by others (that's a separate, much bigger gap — running a
// real multi-tenant discovery service — genuinely out of scope here).
// A bundle is meant to be shared the same way a gist or a file attachment
// already is: export it, hand the JSON to someone else, they install it.

const BUNDLEABLE_DIR_PREFIXES = [".finanfa-code/memory", ".finanfa-code/skills", ".finanfa-code/commands", ".finanfa-code/agents", ".finanfa-code/instructions"];
const BUNDLEABLE_ROOT_FILES = [".finanfa-code/settings.json", ".finanfa-code/mcp.json", "finanfa.md", "finanfa-design.md"];

export interface ClawBundleManifest {
  name: string;
  version: string;
  description?: string;
  createdAt: string;
  /** Where this bundle was exported from — not a security boundary, just a provenance record shown on install. */
  sourceProjectPath: string;
}

export interface ClawBundle {
  manifest: ClawBundleManifest;
  /** Keyed by path relative to the project root (e.g. ".finanfa-code/memory/prefers-atomic-commits.md", "finanfa.md"). */
  files: Record<string, string>;
}

async function readMarkdownFilesFromDir(cwd: string, relDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const absDir = path.join(cwd, relDir);
  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md") && !entry.endsWith(".json")) continue;
    const relPath = `${relDir}/${entry}`;
    try {
      files[relPath] = await readFile(path.join(cwd, relPath), "utf-8");
    } catch {
      // Skip a file that vanished/became unreadable between readdir and readFile — same defensive convention as skills/memory loaders.
    }
  }
  return files;
}

/** Collects every bundleable file (see BUNDLEABLE_DIR_PREFIXES/BUNDLEABLE_ROOT_FILES) that actually exists in `cwd` into a single, shareable bundle. */
export async function exportClawBundle(cwd: string, meta: { name: string; version: string; description?: string }): Promise<ClawBundle> {
  const files: Record<string, string> = {};
  for (const dir of BUNDLEABLE_DIR_PREFIXES) Object.assign(files, await readMarkdownFilesFromDir(cwd, dir));
  for (const relPath of BUNDLEABLE_ROOT_FILES) {
    try {
      files[relPath] = await readFile(path.join(cwd, relPath), "utf-8");
    } catch {
      // Not every project has every one of these files — a missing one is normal, not an error.
    }
  }
  return {
    manifest: { name: meta.name, version: meta.version, description: meta.description, createdAt: new Date().toISOString(), sourceProjectPath: cwd },
    files,
  };
}

function snapshotsDir(cwd: string): string {
  return path.join(cwd, ".finanfa-code", ".claws", "snapshots");
}

export interface ClawSnapshotInfo {
  id: string;
  createdAt: string;
  reason: string;
}

/** Every rollback snapshot recorded for this project, most recent first. */
export async function listClawSnapshots(cwd: string): Promise<ClawSnapshotInfo[]> {
  const dir = snapshotsDir(cwd);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const infos: ClawSnapshotInfo[] = [];
  for (const id of entries) {
    try {
      const raw = await readFile(path.join(dir, id, "manifest.json"), "utf-8");
      const parsed = JSON.parse(raw) as { createdAt: string; reason: string };
      infos.push({ id, createdAt: parsed.createdAt, reason: parsed.reason });
    } catch {
      // A corrupted/partial snapshot directory is skipped, not fatal to listing the rest.
    }
  }
  return infos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Reads the CURRENT on-disk content (or undefined if the file doesn't exist yet) of every path a bundle is about to overwrite, so installing it can be undone. */
async function snapshotCurrentFiles(cwd: string, relPaths: string[], reason: string): Promise<string> {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dir = path.join(snapshotsDir(cwd), id);
  await mkdir(dir, { recursive: true });

  const before: Record<string, string | null> = {};
  for (const relPath of relPaths) {
    try {
      before[relPath] = await readFile(path.join(cwd, relPath), "utf-8");
    } catch {
      before[relPath] = null; // didn't exist before — rollback should delete it, not write an empty file
    }
  }
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), reason }), "utf-8");
  await writeFile(path.join(dir, "files.json"), JSON.stringify(before), "utf-8");
  return id;
}

export interface InstallClawBundleResult {
  snapshotId: string;
  filesWritten: string[];
}

/** Installs `bundle` into `cwd`, snapshotting every file it's about to touch first (see rollbackClawSnapshot) so the install can be undone. */
export async function installClawBundle(cwd: string, bundle: ClawBundle): Promise<InstallClawBundleResult> {
  const relPaths = Object.keys(bundle.files);
  const snapshotId = await snapshotCurrentFiles(cwd, relPaths, `before installing "${bundle.manifest.name}@${bundle.manifest.version}"`);

  for (const relPath of relPaths) {
    const absPath = path.join(cwd, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, bundle.files[relPath]!, "utf-8");
  }
  return { snapshotId, filesWritten: relPaths };
}

/** Restores every file a given install snapshot recorded back to what it was before — deletes a file that didn't exist yet at snapshot time, rather than leaving it behind. */
export async function rollbackClawSnapshot(cwd: string, snapshotId: string): Promise<void> {
  const dir = path.join(snapshotsDir(cwd), snapshotId);
  const raw = await readFile(path.join(dir, "files.json"), "utf-8");
  const before = JSON.parse(raw) as Record<string, string | null>;

  for (const [relPath, content] of Object.entries(before)) {
    const absPath = path.join(cwd, relPath);
    if (content === null) {
      await rm(absPath, { force: true });
    } else {
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf-8");
    }
  }
}

/** True if `snapshotId` looks like a real, existing snapshot for this project — lets a caller give a clear error instead of rollbackClawSnapshot throwing an fs error partway through. */
export async function clawSnapshotExists(cwd: string, snapshotId: string): Promise<boolean> {
  try {
    await stat(path.join(snapshotsDir(cwd), snapshotId, "manifest.json"));
    return true;
  } catch {
    return false;
  }
}
