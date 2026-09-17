import { readFile, writeFile, readdir, mkdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { getOrCreateSigningIdentity, fingerprintPublicKey, signPayload, verifyPayload, canonicalJson } from "./claws-signing.js";
import { isKnownPublisher, recordPublisherSeen } from "./claws-trust-store.js";

// "Claws" — versioned, installable bundles of a project's own
// finanfa-code configuration (permission rules/hooks, MCP servers,
// memory, skills, commands, agent types, path-scoped instructions,
// finanfa.md/finanfa-design.md), with provenance and rollback. A real
// gap relative to a comparable project's own bundle system, distinct
// from this project's existing plugins/ runtime (arbitrary imported JS,
// see docs/plugins.md) — a bundle is inert config+content, shareable as
// a single JSON file with no code execution risk of its own.
//
// This module covers the bundle FORMAT and install/rollback mechanism —
// a bundle can still be shared the same way a gist or a file attachment
// already is: export it, hand the JSON to someone else, they install it.
// For publishing to and discovering bundles from a real hosted registry
// instead, see claws-registry.ts (a GitHub repo as the registry backend).

const BUNDLEABLE_DIR_PREFIXES = [".finanfa-code/memory", ".finanfa-code/skills", ".finanfa-code/commands", ".finanfa-code/agents", ".finanfa-code/instructions"];
const BUNDLEABLE_ROOT_FILES = [".finanfa-code/settings.json", ".finanfa-code/mcp.json", "finanfa.md", "finanfa-design.md"];

/**
 * Real path-traversal gap: `bundle.files` keys come straight from
 * attacker-controllable JSON (install_bundle's `bundle_json` input), and
 * nothing previously stopped a key like "../../../.ssh/authorized_keys"
 * from resolving outside `cwd` before being read (snapshot) or written
 * (install/rollback) — a valid signature (see claws-signing.ts) only
 * proves the *signer* didn't get tampered with in transit, it says
 * nothing about whether the signer themselves put a traversal path in
 * there. `path.resolve` collapses any "..", so a straightforward prefix
 * check on the resolved path is enough — no need for a realpath/symlink
 * check since `cwd` itself isn't attacker-controlled here.
 */
function assertPathsWithinCwd(cwd: string, relPaths: string[]): void {
  const root = path.resolve(cwd) + path.sep;
  for (const relPath of relPaths) {
    const resolved = path.resolve(cwd, relPath);
    if (resolved !== path.resolve(cwd) && !resolved.startsWith(root)) {
      throw new Error(`Bundle file path "${relPath}" resolves outside the project (${cwd}) — refusing to touch it.`);
    }
  }
}

export interface ClawBundleManifest {
  name: string;
  version: string;
  description?: string;
  createdAt: string;
  /** Where this bundle was exported from — not a security boundary, just a provenance record shown on install. */
  sourceProjectPath: string;
  /** The exporting machine's persistent Ed25519 public key (see claws-signing.ts) — its fingerprint is what a later install checks against the local trust store (see claws-trust-store.ts) to tell "known publisher" from "first time seeing this one." */
  publicKeyPem?: string;
  /** Ed25519 signature (base64) over canonicalJson(files) by the private key matching publicKeyPem — proves the bundle's content hasn't changed since whoever holds that key signed it. Doesn't imply the content itself is safe. */
  signature?: string;
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

/** Collects every bundleable file (see BUNDLEABLE_DIR_PREFIXES/BUNDLEABLE_ROOT_FILES) that actually exists in `cwd` into a single, shareable bundle, signed with this machine's own persistent identity (see claws-signing.ts) — auto-generated on first use, stable across every bundle exported from here after that. */
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
  const identity = await getOrCreateSigningIdentity();
  const signature = signPayload(canonicalJson(files), identity.privateKeyPem);
  return {
    manifest: { name: meta.name, version: meta.version, description: meta.description, createdAt: new Date().toISOString(), sourceProjectPath: cwd, publicKeyPem: identity.publicKeyPem, signature },
    files,
  };
}

export type ClawSignatureStatus =
  | { signed: false }
  | { signed: true; valid: true; fingerprint: string; knownPublisher: boolean }
  | { signed: true; valid: false };

/** Checks a bundle's signature (if it has one — an older/hand-built bundle might not) against its own embedded public key, and whether that key's fingerprint has been seen by THIS machine before (see claws-trust-store.ts). Doesn't record anything — see recordBundlePublisherSeen, called separately once a human has actually decided to install. */
export async function verifyClawBundleSignature(bundle: ClawBundle): Promise<ClawSignatureStatus> {
  if (!bundle.manifest.signature || !bundle.manifest.publicKeyPem) return { signed: false };
  const valid = verifyPayload(canonicalJson(bundle.files), bundle.manifest.signature, bundle.manifest.publicKeyPem);
  if (!valid) return { signed: true, valid: false };
  const fingerprint = fingerprintPublicKey(bundle.manifest.publicKeyPem);
  return { signed: true, valid: true, fingerprint, knownPublisher: await isKnownPublisher(fingerprint) };
}

export async function recordBundlePublisherSeen(fingerprint: string, label?: string): Promise<void> {
  await recordPublisherSeen(fingerprint, label);
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

// Two installs landing in the same real millisecond is a real, observed
// case (not hypothetical) — Date.now() alone both collides on id (one
// snapshot silently overwriting the other) and ties on createdAt for
// sort order. This monotonic counter (per process) guarantees each
// snapshot gets a strictly later timestamp than the last one taken here,
// regardless of wall-clock resolution.
let lastSnapshotTimestampMs = 0;
function nextMonotonicTimestampMs(): number {
  const now = Date.now();
  lastSnapshotTimestampMs = now > lastSnapshotTimestampMs ? now : lastSnapshotTimestampMs + 1;
  return lastSnapshotTimestampMs;
}

/** Reads the CURRENT on-disk content (or undefined if the file doesn't exist yet) of every path a bundle is about to overwrite, so installing it can be undone. */
async function snapshotCurrentFiles(cwd: string, relPaths: string[], reason: string): Promise<string> {
  // Defense in depth — installClawBundle already validates before calling
  // this, but snapshotting also READS whatever path it's given, so a
  // future caller that skips that check would otherwise leak arbitrary
  // file content into the snapshot instead of just failing to write.
  assertPathsWithinCwd(cwd, relPaths);
  const createdAt = new Date(nextMonotonicTimestampMs()).toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
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
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ createdAt, reason }), "utf-8");
  await writeFile(path.join(dir, "files.json"), JSON.stringify(before), "utf-8");
  return id;
}

function installedBundlesPath(cwd: string): string {
  return path.join(cwd, ".finanfa-code", ".claws", "installed.json");
}

interface InstalledBundleRecord {
  version: string;
  publisherFingerprint?: string;
  installedAt: string;
}

async function loadInstalledBundles(cwd: string): Promise<Record<string, InstalledBundleRecord>> {
  try {
    return JSON.parse(await readFile(installedBundlesPath(cwd), "utf-8")) as Record<string, InstalledBundleRecord>;
  } catch {
    return {};
  }
}

async function saveInstalledBundle(cwd: string, name: string, record: InstalledBundleRecord): Promise<void> {
  const all = await loadInstalledBundles(cwd);
  all[name] = record;
  await mkdir(path.dirname(installedBundlesPath(cwd)), { recursive: true });
  await writeFile(installedBundlesPath(cwd), JSON.stringify(all, null, 2), "utf-8");
}

/**
 * Compares two version strings loosely as semver (major.minor.patch,
 * numeric parts compared in order, a shorter version treated as padded
 * with zeros) — not a full semver-spec implementation (no build-metadata/
 * prerelease-precedence rules), which is enough to answer "is this an
 * upgrade, a downgrade, or the same version" for a bundle manifest's own
 * free-form version string. Falls back to plain string equality/ordering
 * for anything that doesn't parse as dot-separated numbers, rather than
 * throwing on a non-semver version like "2024-01-01".
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const bothNumeric = [...partsA, ...partsB].every((n) => Number.isFinite(n));
  if (!bothNumeric) return a === b ? 0 : a < b ? -1 : 1;
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export type BundleVersionChange = "new" | "upgrade" | "downgrade" | "same";

export interface InstallClawBundleResult {
  snapshotId: string;
  filesWritten: string[];
  signatureStatus: ClawSignatureStatus;
  /** "new" when this bundle name has never been installed into this project before. */
  versionChange: BundleVersionChange;
  previousVersion?: string;
}

/** Installs `bundle` into `cwd`, snapshotting every file it's about to touch first (see rollbackClawSnapshot) so the install can be undone. Verifies the bundle's signature (if any — see verifyClawBundleSignature) and records its publisher as seen (a valid signature is a real, if partial, trust signal — an install that got this far already passed the "dangerous"-tool human approval gate), and compares against whichever version of this bundle name (if any) was last installed into this project. */
export async function installClawBundle(cwd: string, bundle: ClawBundle): Promise<InstallClawBundleResult> {
  // Fail closed on the WHOLE bundle rather than skipping just the bad
  // entries — a bundle that needs a traversal path to work at all is not
  // one to partially trust.
  assertPathsWithinCwd(cwd, Object.keys(bundle.files));

  const signatureStatus = await verifyClawBundleSignature(bundle);
  if (signatureStatus.signed && signatureStatus.valid) await recordBundlePublisherSeen(signatureStatus.fingerprint);

  const previous = (await loadInstalledBundles(cwd))[bundle.manifest.name];
  const versionChange: BundleVersionChange = !previous
    ? "new"
    : (() => {
        const cmp = compareVersions(bundle.manifest.version, previous.version);
        return cmp === 0 ? "same" : cmp > 0 ? "upgrade" : "downgrade";
      })();

  const relPaths = Object.keys(bundle.files);
  const snapshotId = await snapshotCurrentFiles(cwd, relPaths, `before installing "${bundle.manifest.name}@${bundle.manifest.version}"`);

  for (const relPath of relPaths) {
    const absPath = path.join(cwd, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, bundle.files[relPath]!, "utf-8");
  }

  await saveInstalledBundle(cwd, bundle.manifest.name, {
    version: bundle.manifest.version,
    publisherFingerprint: signatureStatus.signed && signatureStatus.valid ? signatureStatus.fingerprint : undefined,
    installedAt: new Date().toISOString(),
  });

  return { snapshotId, filesWritten: relPaths, signatureStatus, versionChange, previousVersion: previous?.version };
}

/** Restores every file a given install snapshot recorded back to what it was before — deletes a file that didn't exist yet at snapshot time, rather than leaving it behind. */
export async function rollbackClawSnapshot(cwd: string, snapshotId: string): Promise<void> {
  const dir = path.join(snapshotsDir(cwd), snapshotId);
  const raw = await readFile(path.join(dir, "files.json"), "utf-8");
  const before = JSON.parse(raw) as Record<string, string | null>;
  // Defense in depth (see assertPathsWithinCwd's comment) — an install
  // this validation predates could in principle have left an unsafe path
  // in an old snapshot file on disk.
  assertPathsWithinCwd(cwd, Object.keys(before));

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
