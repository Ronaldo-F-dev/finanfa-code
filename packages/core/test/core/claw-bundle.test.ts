import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportClawBundle, installClawBundle, listClawSnapshots, rollbackClawSnapshot, clawSnapshotExists, verifyClawBundleSignature, compareVersions, type ClawBundle } from "../../src/core/claw-bundle.js";

describe("claw bundle (export/install/rollback)", () => {
  let dir: string;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-claw-bundle-"));
    // exportClawBundle now signs with this machine's own persistent identity
    // (~/.finanfa-code/claws-identity.json) — isolate HOME so tests don't
    // read/write the real developer's own identity/trust-store files.
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-claw-bundle-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("exportClawBundle collects memory/skills/commands/agents/instructions and the two root files, skipping what doesn't exist", async () => {
    await mkdir(path.join(dir, ".finanfa-code", "memory"), { recursive: true });
    await writeFile(path.join(dir, ".finanfa-code", "memory", "note.md"), "---\nname: note\n---\n\ncontent");
    await mkdir(path.join(dir, ".finanfa-code", "skills"), { recursive: true });
    await writeFile(path.join(dir, ".finanfa-code", "skills", "deploy.md"), "---\nname: deploy\n---\n\nHow to deploy");
    await writeFile(path.join(dir, "finanfa.md"), "# Project notes");
    // no settings.json/mcp.json/commands/agents/instructions in this project — should just be skipped, not error

    const bundle = await exportClawBundle(dir, { name: "acme", version: "1.0.0" });
    expect(bundle.manifest).toMatchObject({ name: "acme", version: "1.0.0", sourceProjectPath: dir });
    expect(Object.keys(bundle.files).sort()).toEqual([".finanfa-code/memory/note.md", ".finanfa-code/skills/deploy.md", "finanfa.md"]);
    expect(bundle.files["finanfa.md"]).toBe("# Project notes");
  });

  it("exportClawBundle on a project with nothing configured yields an empty file set, not an error", async () => {
    const bundle = await exportClawBundle(dir, { name: "empty", version: "0.0.1" });
    expect(bundle.files).toEqual({});
  });

  it("installClawBundle writes every file, creating directories as needed", async () => {
    const bundle = await exportClawBundle(dir, { name: "x", version: "1" }); // empty, just to build a real bundle shape
    bundle.files[".finanfa-code/memory/imported.md"] = "---\nname: imported\n---\n\nimported content";
    bundle.files["finanfa-design.md"] = "design contract";

    const result = await installClawBundle(dir, bundle);
    expect(result.filesWritten.sort()).toEqual([".finanfa-code/memory/imported.md", "finanfa-design.md"]);
    expect(await readFile(path.join(dir, ".finanfa-code", "memory", "imported.md"), "utf-8")).toBe("---\nname: imported\n---\n\nimported content");
    expect(await readFile(path.join(dir, "finanfa-design.md"), "utf-8")).toBe("design contract");
  });

  it("installClawBundle snapshots the PRIOR content of a file it's about to overwrite, and rollbackClawSnapshot restores it", async () => {
    await writeFile(path.join(dir, "finanfa.md"), "original content");

    const bundle = await exportClawBundle(dir, { name: "x", version: "1" });
    bundle.files["finanfa.md"] = "new content from the bundle";
    const { snapshotId } = await installClawBundle(dir, bundle);
    expect(await readFile(path.join(dir, "finanfa.md"), "utf-8")).toBe("new content from the bundle");

    await rollbackClawSnapshot(dir, snapshotId);
    expect(await readFile(path.join(dir, "finanfa.md"), "utf-8")).toBe("original content");
  });

  it("rollbackClawSnapshot deletes a file that didn't exist before the install, instead of leaving it behind", async () => {
    const bundle = await exportClawBundle(dir, { name: "x", version: "1" });
    bundle.files["finanfa.md"] = "brand new file, nothing here before";
    const { snapshotId } = await installClawBundle(dir, bundle);
    expect(await readFile(path.join(dir, "finanfa.md"), "utf-8")).toBe("brand new file, nothing here before");

    await rollbackClawSnapshot(dir, snapshotId);
    await expect(readFile(path.join(dir, "finanfa.md"), "utf-8")).rejects.toThrow();
  });

  it("listClawSnapshots lists every snapshot for this project, most recent first", async () => {
    const bundle = await exportClawBundle(dir, { name: "x", version: "1" });
    bundle.files["finanfa.md"] = "v1";
    const first = await installClawBundle(dir, bundle);
    bundle.files["finanfa.md"] = "v2";
    const second = await installClawBundle(dir, bundle);

    const snapshots = await listClawSnapshots(dir);
    expect(snapshots.map((s) => s.id)).toEqual([second.snapshotId, first.snapshotId]);
  });

  it("listClawSnapshots returns an empty list when nothing was ever installed", async () => {
    expect(await listClawSnapshots(dir)).toEqual([]);
  });

  it("clawSnapshotExists distinguishes a real snapshot id from a made-up one", async () => {
    const bundle = await exportClawBundle(dir, { name: "x", version: "1" });
    bundle.files["finanfa.md"] = "v1";
    const { snapshotId } = await installClawBundle(dir, bundle);

    expect(await clawSnapshotExists(dir, snapshotId)).toBe(true);
    expect(await clawSnapshotExists(dir, "not-a-real-snapshot-id")).toBe(false);
  });

  describe("signing and publisher trust", () => {
    it("exportClawBundle signs the bundle, and verifyClawBundleSignature confirms it's valid and unrecognized the first time", async () => {
      await writeFile(path.join(dir, "finanfa.md"), "shared conventions");
      const bundle = await exportClawBundle(dir, { name: "acme", version: "1.0.0" });
      expect(bundle.manifest.publicKeyPem).toBeTruthy();
      expect(bundle.manifest.signature).toBeTruthy();

      const status = await verifyClawBundleSignature(bundle);
      expect(status).toMatchObject({ signed: true, valid: true, knownPublisher: false });
    });

    it("installClawBundle records the publisher as seen — a second bundle from the same identity is then a known publisher", async () => {
      await writeFile(path.join(dir, "finanfa.md"), "v1");
      const first = await exportClawBundle(dir, { name: "acme", version: "1.0.0" });
      await installClawBundle(dir, first);

      await writeFile(path.join(dir, "finanfa.md"), "v2");
      const second = await exportClawBundle(dir, { name: "acme", version: "1.0.1" });
      const status = await verifyClawBundleSignature(second);
      expect(status).toMatchObject({ signed: true, valid: true, knownPublisher: true });
      // Same machine identity signed both — same fingerprint.
      if (status.signed && status.valid) {
        const firstStatus = await verifyClawBundleSignature(first);
        expect(firstStatus.signed && firstStatus.valid && firstStatus.fingerprint).toBe(status.fingerprint);
      }
    });

    it("detects a tampered bundle (files changed after signing) as an invalid signature", async () => {
      const bundle = await exportClawBundle(dir, { name: "acme", version: "1.0.0" });
      bundle.files["finanfa.md"] = "tampered content the signer never signed";
      const status = await verifyClawBundleSignature(bundle);
      expect(status).toEqual({ signed: true, valid: false });
    });

    it("reports signed: false for a bundle with no signature at all (hand-built, or predates this feature)", async () => {
      const unsigned: ClawBundle = { manifest: { name: "x", version: "1", createdAt: "now", sourceProjectPath: "/x" }, files: { "finanfa.md": "hi" } };
      expect(await verifyClawBundleSignature(unsigned)).toEqual({ signed: false });
    });

    it("installClawBundle reports the real signature/publisher/version info from a full install", async () => {
      const bundle = await exportClawBundle(dir, { name: "acme", version: "1.0.0" });
      const result = await installClawBundle(dir, bundle);
      expect(result.signatureStatus).toMatchObject({ signed: true, valid: true, knownPublisher: false });
      expect(result.versionChange).toBe("new");
    });
  });

  describe("version tracking", () => {
    it("reports 'new' for the first install of a bundle name, 'same' for a reinstall, 'upgrade'/'downgrade' after that", async () => {
      const bundle = await exportClawBundle(dir, { name: "acme", version: "1.0.0" });

      const first = await installClawBundle(dir, { ...bundle, manifest: { ...bundle.manifest, version: "1.0.0" } });
      expect(first.versionChange).toBe("new");

      const reinstall = await installClawBundle(dir, { ...bundle, manifest: { ...bundle.manifest, version: "1.0.0" } });
      expect(reinstall).toMatchObject({ versionChange: "same", previousVersion: "1.0.0" });

      const upgrade = await installClawBundle(dir, { ...bundle, manifest: { ...bundle.manifest, version: "1.1.0" } });
      expect(upgrade).toMatchObject({ versionChange: "upgrade", previousVersion: "1.0.0" });

      const downgrade = await installClawBundle(dir, { ...bundle, manifest: { ...bundle.manifest, version: "1.0.0" } });
      expect(downgrade).toMatchObject({ versionChange: "downgrade", previousVersion: "1.1.0" });
    });

    it("tracks different bundle names independently", async () => {
      const bundleA = await exportClawBundle(dir, { name: "acme", version: "1.0.0" });
      const bundleB = await exportClawBundle(dir, { name: "other", version: "5.0.0" });
      await installClawBundle(dir, bundleA);
      const resultB = await installClawBundle(dir, bundleB);
      expect(resultB.versionChange).toBe("new"); // "other" has never been installed, even though "acme" has
    });
  });
});

describe("compareVersions", () => {
  it("compares real semver-shaped versions numerically, not lexicographically", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1); // lexicographic would say the opposite
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });

  it("treats a shorter version as zero-padded", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1", "1.0.1")).toBe(-1);
  });

  it("falls back to plain string comparison for a non-numeric version instead of throwing", () => {
    expect(compareVersions("2024-01-01", "2024-01-01")).toBe(0);
    expect(compareVersions("2024-01-01", "2024-02-01")).toBe(-1);
  });
});
