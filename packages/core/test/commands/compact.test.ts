import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { AgentSession } from "../../src/core/session.js";
import type { UIAdapter } from "../../src/ui/adapter.js";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../../src/core/types.js";

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

class FixedSummaryProvider implements LlmProvider {
  calls: StreamTurnParams[] = [];
  constructor(private readonly summary: string) {}
  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    this.calls.push(params);
    return {
      assistantMessage: { role: "assistant", content: this.summary },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  }
}

describe("/compact command", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-compact-cmd-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("summarizes the conversation, reports the count, and toggles busy around the call", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "sys" });
    session.messages = [
      { role: "user", content: "refactor the auth module" },
      { role: "assistant", content: "done, see auth.ts" },
    ];
    const ui = makeUi();
    const provider = new FixedSummaryProvider("User asked to refactor auth; auth.ts was updated.");

    const outcome = await commands.get("compact")!({
      session,
      ui,
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never,
      provider,
      setSession: vi.fn(),
      cwd: dir,
      args: "",
    });

    expect(outcome).toBe("continue");
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1]).toEqual({ role: "assistant", content: "User asked to refactor auth; auth.ts was updated." });
    expect(ui.setBusy).toHaveBeenCalledWith(true, "compacting");
    expect(ui.setBusy).toHaveBeenCalledWith(false);
    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("Compacted 2 messages"));
  });

  it("reports failure clearly, without touching the conversation, when there's nothing to compact", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "sys" });
    const ui = makeUi();
    const provider = new FixedSummaryProvider("unused");

    await commands.get("compact")!({
      session,
      ui,
      tools: undefined as never,
      permissions: undefined as never,
      mcp: undefined as never,
      provider,
      setSession: vi.fn(),
      cwd: dir,
      args: "",
    });

    expect(session.messages).toHaveLength(0);
    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("Nothing to compact"));
  });
});
