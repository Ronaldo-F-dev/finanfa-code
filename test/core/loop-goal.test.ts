import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeStubUi(): UIAdapter {
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

class CapturingProvider implements LlmProvider {
  seenSystemPrompts: string[] = [];
  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    this.seenSystemPrompts.push(params.systemPrompt);
    return {
      assistantMessage: { role: "assistant", content: "done" },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  }
}

describe("runTurn: injects the session goal (/goal) into the system prompt", () => {
  it("includes the goal, clearly framed as a standing objective, when one is set", async () => {
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "base prompt" });
    session.goal = "migrate the auth system to OAuth";
    const provider = new CapturingProvider();

    await runTurn(session, provider, ui, new ToolRegistry(), permissions, "what should I do next?");

    expect(provider.seenSystemPrompts[0]).toContain('standing goal for this session: "migrate the auth system to OAuth"');
    expect(provider.seenSystemPrompts[0]).toContain("base prompt");
    expect(session.systemPrompt).toBe("base prompt");
  });

  it("adds nothing goal-related when no goal is set", async () => {
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "base prompt" });
    const provider = new CapturingProvider();

    await runTurn(session, provider, ui, new ToolRegistry(), permissions, "hi");

    expect(provider.seenSystemPrompts[0]).not.toContain("standing goal");
  });

  it("reflects a goal cleared mid-session (no stale goal text on the next turn)", async () => {
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "base prompt" });
    const provider = new CapturingProvider();

    session.goal = "first goal";
    await runTurn(session, provider, ui, new ToolRegistry(), permissions, "turn 1");
    expect(provider.seenSystemPrompts[0]).toContain('"first goal"');

    session.goal = undefined;
    await runTurn(session, provider, ui, new ToolRegistry(), permissions, "turn 2");
    expect(provider.seenSystemPrompts[1]).not.toContain("standing goal");
  });
});
