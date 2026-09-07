import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { AgentSession } from "../../src/core/session.js";
import type { UIAdapter } from "../../src/ui/adapter.js";
import type { NeutralMessage } from "../../src/core/types.js";

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

describe("/rewind command", () => {
  let dir: string;
  let homeDir: string;
  let originalHome: string | undefined;
  let commands: CommandRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-rewind-cmd-"));
    // handleRewind calls session.persist(), which writes under
    // ~/.finanfa-code/sessions — override $HOME so that never touches the
    // real user's home directory.
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-rewind-cmd-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    commands = new CommandRegistry();
    registerBuiltinCommands(commands);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  function ctx(session: AgentSession, args: string) {
    const ui = makeUi();
    return {
      session,
      ui,
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never,
      provider: undefined as never,
      setSession: () => {},
      cwd: dir,
      args,
    };
  }

  it("reports no checkpoints when none exist yet", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    const c = ctx(session, "");
    await commands.get("rewind")!(c);
    expect(c.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("No checkpoints yet"));
  });

  it("lists checkpoints with their preview text when called with no args", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    session.checkpoints.push({ messageIndex: 1, historySize: 0, preview: "first message" });
    session.checkpoints.push({ messageIndex: 3, historySize: 1, preview: "second message" });

    const c = ctx(session, "");
    await commands.get("rewind")!(c);
    expect(c.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("1. first message"));
    expect(c.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("2. second message"));
  });

  it("restores conversation and reverts every file change since the chosen checkpoint", async () => {
    const filePath = path.join(dir, "a.txt");
    await writeFile(filePath, "original");

    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    const messages: NeutralMessage[] = [
      { role: "user", content: "first message" },
      { role: "assistant", content: "ok, editing" },
      { role: "user", content: "second message" },
      { role: "assistant", content: "done" },
    ];
    session.messages = messages;
    // Checkpoint 1 recorded right after the first user message was pushed
    // (messageIndex 1, no edits yet); the file edit happened after that.
    session.checkpoints.push({ messageIndex: 1, historySize: 0, preview: "first message" });
    session.history.push({ path: filePath, before: "original" });
    await writeFile(filePath, "changed by the agent");
    session.checkpoints.push({ messageIndex: 3, historySize: 1, preview: "second message" });

    const c = ctx(session, "1");
    const outcome = await commands.get("rewind")!(c);

    expect(outcome).toBe("continue");
    expect(await readFile(filePath, "utf-8")).toBe("original");
    expect(session.messages).toEqual([]); // truncated to before messageIndex 1 (index 0)
    expect(session.checkpoints).toEqual([]);
  });

  it("keeps messages/checkpoints before the chosen one intact", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    session.messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
      { role: "assistant", content: "ok2" },
    ];
    session.checkpoints.push({ messageIndex: 1, historySize: 0, preview: "first" });
    session.checkpoints.push({ messageIndex: 3, historySize: 0, preview: "second" });

    const c = ctx(session, "2");
    await commands.get("rewind")!(c);

    expect(session.messages).toEqual([{ role: "user", content: "first" }, { role: "assistant", content: "ok" }]);
    expect(session.checkpoints).toEqual([{ messageIndex: 1, historySize: 0, preview: "first" }]);
  });

  it("rejects an out-of-range or non-numeric argument", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    session.checkpoints.push({ messageIndex: 1, historySize: 0, preview: "first" });

    const c1 = ctx(session, "0");
    await commands.get("rewind")!(c1);
    expect(c1.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Usage: /rewind"));

    const c2 = ctx(session, "5");
    await commands.get("rewind")!(c2);
    expect(c2.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Usage: /rewind"));

    const c3 = ctx(session, "abc");
    await commands.get("rewind")!(c3);
    expect(c3.ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Usage: /rewind"));
  });
});
