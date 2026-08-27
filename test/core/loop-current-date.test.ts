import { describe, expect, it, vi, afterEach } from "vitest";
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

describe("runTurn: injects the current date into the system prompt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes today's real date, not baked into the stored session.systemPrompt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "base prompt" });
    const provider = new CapturingProvider();

    await runTurn(session, provider, ui, new ToolRegistry(), permissions, "what's today's date?");

    expect(provider.seenSystemPrompts[0]).toContain("Today's date is 2026-08-27");
    expect(provider.seenSystemPrompts[0]).toContain("base prompt");
    // Real, reported case: the model still typed a stale/habitual year into
    // a web_search query despite knowing today's date — tell it explicitly
    // to derive the year for time-sensitive searches from the injected date.
    expect(provider.seenSystemPrompts[0]).toContain("derive the year from 2026-08-27");
    // The stored session prompt itself stays untouched — only the outgoing call is augmented.
    expect(session.systemPrompt).toBe("base prompt");
  });

  it("reflects the current date at call time, even for a session created earlier", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    // Session object created "long ago" — nothing here should depend on that moment.
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "base prompt" });
    const provider = new CapturingProvider();

    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));
    await runTurn(session, provider, ui, new ToolRegistry(), permissions, "hi");

    expect(provider.seenSystemPrompts[0]).toContain("Today's date is 2026-08-27");
  });
});
