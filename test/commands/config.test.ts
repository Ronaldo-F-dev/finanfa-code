import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { loadConfig } from "../../src/core/config.js";
import { AgentSession } from "../../src/core/session.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeUi(): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
    writeSystem: vi.fn(),
    writeError: vi.fn(),
    setStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(undefined),
    setCommands: vi.fn(),
    setBusy: vi.fn(),
    askUser: vi.fn().mockResolvedValue(""),
    close: vi.fn(),
  };
}

describe("/config command", () => {
  let homeDir: string;
  let projectDir: string;
  let originalHome: string | undefined;
  let commands: CommandRegistry;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-config-cmd-home-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-config-cmd-project-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    commands = new CommandRegistry();
    registerBuiltinCommands(commands);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  function baseCtx(args: string) {
    const session = new AgentSession({ cwd: projectDir, model: "m", systemPrompt: "s" });
    return {
      session,
      ui: makeUi(),
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never,
      cwd: projectDir,
      args,
    };
  }

  it("reports no config set initially", async () => {
    const ctx = baseCtx("");
    await commands.get("config")!(ctx);
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("No config set"));
  });

  it("/config set persists a value that a later /config show reflects", async () => {
    const setCtx = baseCtx("set model claude-opus-5");
    await commands.get("config")!(setCtx);
    expect(setCtx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("Saved model"));

    expect(await loadConfig(projectDir)).toEqual({ model: "claude-opus-5" });

    const showCtx = baseCtx("show");
    await commands.get("config")!(showCtx);
    expect(showCtx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("model: claude-opus-5"));
  });

  it("masks the apiKey value when shown", async () => {
    await commands.get("config")!(baseCtx("set apiKey sk-ant-1234567890abcdef"));

    const showCtx = baseCtx("show");
    await commands.get("config")!(showCtx);

    const shown = (showCtx.ui.writeSystem as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(shown).not.toContain("sk-ant-1234567890abcdef");
    expect(shown).toContain("apiKey:");
  });

  it("/config set visionModel persists it, separate from the primary model", async () => {
    await commands.get("config")!(baseCtx("set model claude-opus-5"));
    await commands.get("config")!(baseCtx("set visionModel claude-sonnet-5"));

    expect(await loadConfig(projectDir)).toEqual({ model: "claude-opus-5", visionModel: "claude-sonnet-5" });
  });

  it("masks the visionApiKey value the same way as apiKey", async () => {
    await commands.get("config")!(baseCtx("set visionApiKey sk-ant-1234567890abcdef"));

    const showCtx = baseCtx("show");
    await commands.get("config")!(showCtx);

    const shown = (showCtx.ui.writeSystem as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(shown).not.toContain("sk-ant-1234567890abcdef");
    expect(shown).toContain("visionApiKey:");
  });

  it("rejects an unknown key", async () => {
    const ctx = baseCtx("set notarealkey value");
    await commands.get("config")!(ctx);
    expect(ctx.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(await loadConfig(projectDir)).toEqual({});
  });

  it("/config clear removes all saved values", async () => {
    await commands.get("config")!(baseCtx("set provider anthropic"));
    expect(await loadConfig(projectDir)).not.toEqual({});

    await commands.get("config")!(baseCtx("clear"));
    expect(await loadConfig(projectDir)).toEqual({});
  });
});
