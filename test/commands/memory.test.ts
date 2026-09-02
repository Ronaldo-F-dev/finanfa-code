import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { writeMemoryTool } from "../../src/memory/loader.js";
import { AgentSession } from "../../src/core/session.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeUi(): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
    writeBanner: vi.fn(),
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

describe("/memory command", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-memory-cmd-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function baseCtx(args = "") {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    return {
      session,
      ui: makeUi(),
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never,
      cwd: dir,
      args,
    };
  }

  it("reports no memories saved initially", async () => {
    const commands = new CommandRegistry();
    registerBuiltinCommands(commands);
    const ctx = baseCtx();

    await commands.get("memory")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("No memories saved"));
  });

  it("lists a memory written via write_memory", async () => {
    const commands = new CommandRegistry();
    registerBuiltinCommands(commands);
    await writeMemoryTool.handler(
      { name: "prefers-atomic-commits", description: "one feature per commit", type: "feedback", content: "..." },
      { cwd: dir, sessionId: "s", signal: new AbortController().signal },
    );

    const ctx = baseCtx();
    await commands.get("memory")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(
      expect.stringContaining("prefers-atomic-commits (feedback): one feature per commit"),
    );
  });
});
