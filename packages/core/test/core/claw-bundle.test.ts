import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportClawBundle, installClawBundle, listClawSnapshots, rollbackClawSnapshot, clawSnapshotExists } from "../../src/core/claw-bundle.js";

describe("claw bundle (export/install/rollback)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-claw-bundle-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
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
});
