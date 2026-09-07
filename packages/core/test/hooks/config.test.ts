import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHooksConfig, EMPTY_HOOKS_CONFIG } from "../../src/hooks/config.js";

describe("hooks/config", () => {
  let homeDir: string;
  let projectDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-hooksconfig-home-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-hooksconfig-project-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns an empty config when no config files exist", async () => {
    expect(await loadHooksConfig(projectDir)).toEqual(EMPTY_HOOKS_CONFIG);
  });

  it("reads project-local PreToolUse hooks from settings.json", async () => {
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "echo hi" }] }] } }),
    );

    const config = await loadHooksConfig(projectDir);
    expect(config.PreToolUse).toEqual([{ matcher: "bash", hooks: [{ type: "command", command: "echo hi" }] }]);
  });

  it("concatenates hooks for the same event from both files, global first", async () => {
    await mkdir(path.join(homeDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".finanfa-code", "config.json"),
      JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "global-hook" }] }] } }),
    );
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "project-hook" }] }] } }),
    );

    const config = await loadHooksConfig(projectDir);
    expect(config.PostToolUse).toEqual([
      { hooks: [{ type: "command", command: "global-hook" }] },
      { hooks: [{ type: "command", command: "project-hook" }] },
    ]);
  });

  it("leaves an event undefined when neither file configures it", async () => {
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "settings.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
    );

    const config = await loadHooksConfig(projectDir);
    expect(config.PreToolUse).toBeUndefined();
    expect(config.PostToolUse).toBeUndefined();
    expect(config.UserPromptSubmit).toHaveLength(1);
  });

  it("ignores project-local settings.json hooks entirely when trusted:false is passed", async () => {
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo pwned" }] }] } }),
    );

    const config = await loadHooksConfig(projectDir, false);
    expect(config).toEqual(EMPTY_HOOKS_CONFIG);
  });

  it("still applies global config.json hooks when trusted:false is passed (only the project file is gated)", async () => {
    await mkdir(path.join(homeDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".finanfa-code", "config.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo global" }] }] } }),
    );

    const config = await loadHooksConfig(projectDir, false);
    expect(config.PreToolUse).toEqual([{ hooks: [{ type: "command", command: "echo global" }] }]);
  });

  it("falls back to an empty config on malformed JSON instead of throwing, and warns about it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
      await writeFile(path.join(projectDir, ".finanfa-code", "settings.json"), "{ not valid json");

      const config = await loadHooksConfig(projectDir);
      expect(config).toEqual(EMPTY_HOOKS_CONFIG);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain("settings.json");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
