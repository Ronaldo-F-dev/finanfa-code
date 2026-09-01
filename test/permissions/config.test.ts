import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPermissionConfig, DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";

describe("permissions/config", () => {
  let homeDir: string;
  let projectDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-permconfig-home-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-permconfig-project-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns the built-in defaults when no config files exist", async () => {
    expect(await loadPermissionConfig(projectDir)).toEqual(DEFAULT_PERMISSION_CONFIG);
  });

  it("project-local defaultForRiskLevel overrides global, field by field", async () => {
    await mkdir(path.join(homeDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".finanfa-code", "config.json"),
      JSON.stringify({ defaultForRiskLevel: { dangerous: "deny" } }),
    );
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "settings.json"),
      JSON.stringify({ defaultForRiskLevel: { ask: "allow" } }),
    );

    const config = await loadPermissionConfig(projectDir);
    expect(config.defaultForRiskLevel).toEqual({ safe: "allow", ask: "allow", dangerous: "deny" });
  });

  it("concatenates rules from both files, global first", async () => {
    await mkdir(path.join(homeDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".finanfa-code", "config.json"),
      JSON.stringify({ rules: [{ tool: "bash", keyPrefix: "git", decision: "allow" }] }),
    );
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "settings.json"),
      JSON.stringify({ rules: [{ tool: "git_push", decision: "ask" }] }),
    );

    const config = await loadPermissionConfig(projectDir);
    expect(config.rules).toEqual([
      { tool: "bash", keyPrefix: "git", decision: "allow" },
      { tool: "git_push", decision: "ask" },
    ]);
  });

  it("falls back to defaults on malformed JSON instead of throwing, and warns about it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
      await writeFile(path.join(projectDir, ".finanfa-code", "settings.json"), "{ not valid json");

      const config = await loadPermissionConfig(projectDir);
      expect(config).toEqual(DEFAULT_PERMISSION_CONFIG);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain("settings.json");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
