import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import type { HooksConfig } from "../../src/hooks/config.js";
import type { LlmProvider, StreamTurnResult, NeutralMessage } from "../../src/core/types.js";
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

/** Replies with the given texts in order (repeating the last), recording what each call was sent. */
function scriptedProvider(replies: string[]) {
  const calls: Array<{ system: string; messages: NeutralMessage[] }> = [];
  const provider: LlmProvider = {
    async streamTurn(req: { systemPrompt?: string; messages: NeutralMessage[] }): Promise<StreamTurnResult> {
      // The fire-and-forget title generator (maybeGenerateTitle) also talks to the provider — answer it without counting it as an agent call.
      if (req.systemPrompt?.startsWith("Reply with ONLY a short title")) {
        return { assistantMessage: { role: "assistant", content: "A title" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
      calls.push({ system: req.systemPrompt ?? "", messages: [...req.messages] });
      const content = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { assistantMessage: { role: "assistant", content }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    },
  } as LlmProvider;
  return { provider, calls };
}

const originalHome = process.env.HOME;
let cwd: string;
beforeEach(async () => {
  process.env.HOME = await mkdtemp(path.join(tmpdir(), "finanfa-home-"));
  cwd = await mkdtemp(path.join(tmpdir(), "finanfa-cwd-"));
});
afterEach(() => {
  process.env.HOME = originalHome;
});

function setup(replies: string[], hooksConfig?: HooksConfig) {
  const ui = makeUi();
  const { provider, calls } = scriptedProvider(replies);
  const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig });
  const session = new AgentSession({ cwd, model: "m", systemPrompt: "base" });
  return { ui, provider, calls, permissions, session, tools: new ToolRegistry() };
}

describe("Stop hook", () => {
  it("forces one more iteration with the hook's reason, then lets the turn end", async () => {
    const hooks: HooksConfig = { Stop: [{ hooks: [{ type: "command", command: "cat >/dev/null; echo 'run the tests first' >&2; exit 2" }] }] };
    const s = setup(["first answer", "second answer"], hooks);
    await runTurn(s.session, s.provider, s.ui, s.tools, s.permissions, "do it");

    expect(s.calls).toHaveLength(2);
    const feedback = s.calls[1].messages.at(-1);
    expect(feedback?.role).toBe("user");
    expect((feedback as { content: string }).content).toContain("run the tests first");
    expect(s.session.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("does nothing without a Stop hook", async () => {
    const s = setup(["only answer"]);
    await runTurn(s.session, s.provider, s.ui, s.tools, s.permissions, "do it");
    expect(s.calls).toHaveLength(1);
  });
});

describe("SessionStart hook", () => {
  it("injects its stdout into the first prompt only", async () => {
    const hooks: HooksConfig = { SessionStart: [{ hooks: [{ type: "command", command: "cat >/dev/null; echo 'branch: main'" }] }] };
    const s = setup(["ok"], hooks);
    await runTurn(s.session, s.provider, s.ui, s.tools, s.permissions, "first");
    await runTurn(s.session, s.provider, s.ui, s.tools, s.permissions, "second");
    const users = s.session.messages.filter((m) => m.role === "user") as Array<{ content: string }>;
    expect(users[0].content).toContain("<session-start-hook-context>\nbranch: main");
    expect(users[1].content).toBe("second");
  });
});

describe("output styles", () => {
  it("adds the chosen style to the system prompt on the next turn", async () => {
    const commands = new CommandRegistry();
    registerBuiltinCommands(commands);
    const s = setup(["ok"]);
    const ctx = { session: s.session, ui: s.ui, tools: s.tools, permissions: s.permissions, mcp: {}, provider: s.provider, cwd, args: "explanatory", setSession: vi.fn() } as never;
    await commands.get("output-style")!(ctx);
    await runTurn(s.session, s.provider, s.ui, s.tools, s.permissions, "hi");
    expect(s.calls[0].system).toContain("Output style, explanatory");

    await commands.get("output-style")!({ ...(ctx as object), args: "bogus" } as never);
    expect(s.ui.writeError).toHaveBeenCalledWith(expect.stringContaining('Unknown output style "bogus"'));
  });
});

describe("/ralph-loop", () => {
  function ctxFor(s: ReturnType<typeof setup>, args: string) {
    return { session: s.session, ui: s.ui, tools: s.tools, permissions: s.permissions, mcp: {}, provider: s.provider, cwd, args, setSession: vi.fn() } as never;
  }
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  it("stops as soon as the agent answers the completion promise", async () => {
    const s = setup(["working", "still working", "all good <promise>DONE</promise>"]);
    await commands.get("ralph-loop")!(ctxFor(s, "fix the bug"));
    expect(s.calls).toHaveLength(3);
    expect(s.ui.writeSystem).toHaveBeenCalledWith("(ralph-loop: finished after 3 iteration(s))");
  });

  it("honors --max and --until, and stops at the cap", async () => {
    const s = setup(["never done"]);
    await commands.get("ralph-loop")!(ctxFor(s, "--max 2 --until FIN task"));
    expect(s.calls).toHaveLength(2);
    expect(s.ui.writeSystem).toHaveBeenCalledWith("(ralph-loop: stopped at the 2-iteration cap without a completion promise)");
  });

  it("requires a task", async () => {
    const s = setup(["x"]);
    await commands.get("ralph-loop")!(ctxFor(s, "--max 3"));
    expect(s.calls).toHaveLength(0);
    expect(s.ui.writeError).toHaveBeenCalled();
  });
});
