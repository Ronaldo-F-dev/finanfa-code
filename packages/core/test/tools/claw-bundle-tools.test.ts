import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportBundleTool, installBundleTool, listBundleSnapshotsTool, rollbackBundleTool } from "../../src/tools/builtin/claw-bundle-tools.js";
import type { ClawBundle } from "../../src/core/claw-bundle.js";

describe("bundle tools (export_bundle/install_bundle/list_bundle_snapshots/rollback_bundle)", () => {
  let dir: string;
  let homeDir: string;
  let originalHome: string | undefined;
  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-claw-bundle-tools-"));
    // export_bundle now signs with this machine's own persistent identity
    // (~/.finanfa-code/claws-identity.json) — isolate HOME so tests don't
    // read/write the real developer's own identity/trust-store files.
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-claw-bundle-tools-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("export_bundle produces real bundle JSON with the given name/version and this project's actual files", async () => {
    await mkdir(path.join(dir, ".finanfa-code", "memory"), { recursive: true });
    await writeFile(path.join(dir, ".finanfa-code", "memory", "note.md"), "---\nname: note\n---\n\ncontent");

    const result = await exportBundleTool.handler({ name: "acme", version: "1.0.0" }, ctx());
    expect(result.isError).toBe(false);
    const bundle = JSON.parse(result.content) as ClawBundle;
    expect(bundle.manifest.name).toBe("acme");
    expect(bundle.files[".finanfa-code/memory/note.md"]).toContain("content");
  });

  it("export_bundle reports plainly when there's nothing to bundle yet", async () => {
    const result = await exportBundleTool.handler({ name: "empty", version: "1" }, ctx());
    expect(result.content).toContain("Nothing to bundle");
  });

  it("install_bundle writes the bundle's files and reports a real snapshot id", async () => {
    const bundle: ClawBundle = {
      manifest: { name: "acme", version: "2.0.0", createdAt: new Date().toISOString(), sourceProjectPath: "/elsewhere" },
      files: { "finanfa.md": "shared conventions" },
    };

    const result = await installBundleTool.handler({ bundle_json: JSON.stringify(bundle) }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Installed "acme@2.0.0"');
    expect(result.content).toMatch(/Snapshot "[^"]+" saved/);
    expect(await readFile(path.join(dir, "finanfa.md"), "utf-8")).toBe("shared conventions");
  });

  it("install_bundle rejects unparseable JSON with a clear error instead of throwing", async () => {
    const result = await installBundleTool.handler({ bundle_json: "not json" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Not valid bundle JSON");
  });

  it("install_bundle rejects a well-formed JSON object that isn't actually a bundle", async () => {
    const result = await installBundleTool.handler({ bundle_json: JSON.stringify({ hello: "world" }) }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Not a valid bundle");
  });

  it("install_bundle's describeCall names the bundle for confirmation, without needing the handler", () => {
    const bundle: ClawBundle = { manifest: { name: "acme", version: "3.0.0", createdAt: "now", sourceProjectPath: "/x" }, files: { a: "1", b: "2" } };
    expect(installBundleTool.describeCall?.({ bundle_json: JSON.stringify(bundle) })).toBe('install bundle "acme@3.0.0" (2 file(s))');
  });

  it("list_bundle_snapshots reports none installed yet, then a real one after install_bundle runs", async () => {
    const before = await listBundleSnapshotsTool.handler({}, ctx());
    expect(before.content).toContain("No bundle install snapshots");

    const bundle: ClawBundle = { manifest: { name: "acme", version: "1.0.0", createdAt: "now", sourceProjectPath: "/x" }, files: { "finanfa.md": "hi" } };
    await installBundleTool.handler({ bundle_json: JSON.stringify(bundle) }, ctx());

    const after = await listBundleSnapshotsTool.handler({}, ctx());
    expect(after.content).toContain('before installing "acme@1.0.0"');
  });

  it("rollback_bundle restores the prior content after install_bundle overwrote it", async () => {
    await writeFile(path.join(dir, "finanfa.md"), "original");
    const bundle: ClawBundle = { manifest: { name: "acme", version: "1.0.0", createdAt: "now", sourceProjectPath: "/x" }, files: { "finanfa.md": "overwritten by bundle" } };
    const installResult = await installBundleTool.handler({ bundle_json: JSON.stringify(bundle) }, ctx());
    const snapshotId = installResult.content.match(/Snapshot "([^"]+)"/)![1]!;

    expect(await readFile(path.join(dir, "finanfa.md"), "utf-8")).toBe("overwritten by bundle");
    const rollbackResult = await rollbackBundleTool.handler({ snapshot_id: snapshotId }, ctx());
    expect(rollbackResult.isError).toBe(false);
    expect(await readFile(path.join(dir, "finanfa.md"), "utf-8")).toBe("original");
  });

  it("rollback_bundle reports a clear error for an unknown snapshot id, instead of throwing", async () => {
    const result = await rollbackBundleTool.handler({ snapshot_id: "nonexistent" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No bundle snapshot "nonexistent"');
  });

  it("has the expected risk levels: safe to export/list, dangerous to install, ask to roll back", () => {
    expect(exportBundleTool.riskLevel).toBe("safe");
    expect(listBundleSnapshotsTool.riskLevel).toBe("safe");
    expect(installBundleTool.riskLevel).toBe("dangerous");
    expect(rollbackBundleTool.riskLevel).toBe("ask");
  });
});
