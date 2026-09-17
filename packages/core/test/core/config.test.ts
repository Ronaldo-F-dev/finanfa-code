import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, saveGlobalConfig, globalConfigPath, thinkingBudgetTokensFromConfig, resolveToolSearchEnabled } from "../../src/core/config.js";

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

  it("warns (but doesn't throw) on malformed JSON, unlike a plain missing file", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(errorSpy).not.toHaveBeenCalled();
      await loadConfig(projectDir); // no file at all — silent
      expect(errorSpy).not.toHaveBeenCalled();

      await mkdir(path.dirname(globalConfigPath()), { recursive: true });
      await writeFile(globalConfigPath(), "{ not valid json", "utf-8");
      await loadConfig(projectDir);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain(globalConfigPath());
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("thinkingBudgetTokensFromConfig", () => {
  it("returns undefined when unset", () => {
    expect(thinkingBudgetTokensFromConfig({})).toBeUndefined();
  });

  it("parses a plain numeric string", () => {
    expect(thinkingBudgetTokensFromConfig({ thinkingBudgetTokens: "4096" })).toBe(4096);
  });

  it("returns undefined for a non-numeric or non-positive value, instead of NaN/0", () => {
    expect(thinkingBudgetTokensFromConfig({ thinkingBudgetTokens: "not a number" })).toBeUndefined();
    expect(thinkingBudgetTokensFromConfig({ thinkingBudgetTokens: "0" })).toBeUndefined();
    expect(thinkingBudgetTokensFromConfig({ thinkingBudgetTokens: "-5" })).toBeUndefined();
  });
});

describe("resolveToolSearchEnabled", () => {
  it("follows the local-provider heuristic when unset ('auto')", () => {
    expect(resolveToolSearchEnabled({}, true)).toBe(true);
    expect(resolveToolSearchEnabled({}, false)).toBe(false);
  });

  it("an explicit true always wins, even against a non-local provider", () => {
    expect(resolveToolSearchEnabled({ toolSearch: "true" }, false)).toBe(true);
  });

  it("an explicit false always wins, even against a local provider", () => {
    expect(resolveToolSearchEnabled({ toolSearch: "false" }, true)).toBe(false);
  });

  it("the string 'auto' behaves the same as unset", () => {
    expect(resolveToolSearchEnabled({ toolSearch: "auto" }, true)).toBe(true);
    expect(resolveToolSearchEnabled({ toolSearch: "auto" }, false)).toBe(false);
  });
});
