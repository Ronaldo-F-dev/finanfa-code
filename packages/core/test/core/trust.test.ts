import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isFolderTrusted, trustFolder } from "../../src/core/trust.js";

describe("core/trust (real filesystem)", () => {
  let homeDir: string;
  let projectDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-trust-home-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-trust-project-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("a folder is untrusted by default", async () => {
    expect(await isFolderTrusted(projectDir)).toBe(false);
  });

  it("trustFolder makes a folder trusted", async () => {
    await trustFolder(projectDir);
    expect(await isFolderTrusted(projectDir)).toBe(true);
  });

  it("trusting one folder does not trust a different one", async () => {
    const otherDir = await mkdtemp(path.join(tmpdir(), "finanfa-trust-other-"));
    try {
      await trustFolder(projectDir);
      expect(await isFolderTrusted(otherDir)).toBe(false);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("persists across separate calls (a real file on disk, not in-memory state)", async () => {
    await trustFolder(projectDir);
    // A second, independent check re-reads from disk — proves this isn't
    // just a module-level in-memory Set that happens to still be warm.
    expect(await isFolderTrusted(projectDir)).toBe(true);
    const raw = await readFile(path.join(homeDir, ".finanfa-code", "trusted-folders.json"), "utf-8");
    expect(JSON.parse(raw)).toContain(path.resolve(projectDir));
  });

  it("trusting a second folder keeps the first one trusted too", async () => {
    const otherDir = await mkdtemp(path.join(tmpdir(), "finanfa-trust-other2-"));
    try {
      await trustFolder(projectDir);
      await trustFolder(otherDir);
      expect(await isFolderTrusted(projectDir)).toBe(true);
      expect(await isFolderTrusted(otherDir)).toBe(true);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("falls back to untrusted (fail safe) when ~/.finanfa-code isn't a directory yet at all", async () => {
    // No mkdir has happened yet in this test — the whole ~/.finanfa-code
    // tree is absent. Must not throw; must report untrusted.
    expect(await isFolderTrusted(projectDir)).toBe(false);
  });

  it("falls back to untrusted (fail safe) on a malformed trust file instead of throwing", async () => {
    await mkdir(path.join(homeDir, ".finanfa-code"), { recursive: true });
    await import("node:fs/promises").then((m) => m.writeFile(path.join(homeDir, ".finanfa-code", "trusted-folders.json"), "{ not valid json"));
    expect(await isFolderTrusted(projectDir)).toBe(false);
  });
});
