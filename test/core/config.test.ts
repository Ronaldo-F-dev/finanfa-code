import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, saveGlobalConfig, globalConfigPath } from "../../src/core/config.js";

describe("core/config", () => {
  let homeDir: string;
  let projectDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-config-home-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-config-project-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns an empty config when no files exist", async () => {
    expect(await loadConfig(projectDir)).toEqual({});
  });

  it("saveGlobalConfig writes to ~/.finanfa-code/config.json, readable via loadConfig", async () => {
    await saveGlobalConfig({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(await loadConfig(projectDir)).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(globalConfigPath()).toBe(path.join(homeDir, ".finanfa-code", "config.json"));
  });

  it("restricts the global config file to owner read/write (may contain an API key)", async () => {
    await saveGlobalConfig({ apiKey: "secret" });
    const stats = await stat(globalConfigPath());
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("merges global and project-local config, project-local taking priority", async () => {
    await saveGlobalConfig({ provider: "anthropic", model: "claude-sonnet-5", apiKey: "global-key" });
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ model: "claude-opus-5" }),
      "utf-8",
    );

    expect(await loadConfig(projectDir)).toEqual({
      provider: "anthropic",
      model: "claude-opus-5", // project override wins
      apiKey: "global-key", // untouched field still comes from global
    });
  });

  it("does not throw on a corrupt/invalid JSON config file", async () => {
    await mkdir(path.dirname(globalConfigPath()), { recursive: true });
    await writeFile(globalConfigPath(), "{ not valid json", "utf-8");
    await expect(loadConfig(projectDir)).resolves.toEqual({});
  });
});
