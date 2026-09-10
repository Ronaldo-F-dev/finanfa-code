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
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-memory-cmd-"));
    // loadMemories() merges in ~/.finanfa-code/memory (global) alongside the
    // project-local one — without overriding $HOME, this test depended on
    // the real machine's global memory dir happening to be empty, which
    // broke for real the moment anything (a genuine saved memory, e.g. a
    // durable environment note) existed there.
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-memory-cmd-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  function baseCtx(args = "") {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    return {
      session,
      ui: makeUi(),
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never, provider: undefined as never,
      setSession: () => {},
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
