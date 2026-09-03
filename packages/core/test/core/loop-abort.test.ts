import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { LlmProvider, StreamTurnResult } from "../../src/core/types.js";
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

class OneToolProvider implements LlmProvider {
  calls = 0;
  async streamTurn(): Promise<StreamTurnResult> {
    this.calls++;
    if (this.calls === 1) {
      return {
        assistantMessage: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "slow_tool", input: {} }] },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      };
    }
    return {
      assistantMessage: { role: "assistant", content: "done" },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  }
}

describe("runTurn: session.activeAbortControllers (Ctrl+C interruption wiring)", () => {
  it("registers exactly one controller while a tool call is in flight, then removes it when done", async () => {
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    let sizeDuringCall = -1;

    const tools = new ToolRegistry();
    tools.register({
      name: "slow_tool",
      description: "d",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      async handler() {
        sizeDuringCall = session.activeAbortControllers.size;
        return { content: "ok", isError: false };
      },
    });

    expect(session.activeAbortControllers.size).toBe(0);

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    await runTurn(session, new OneToolProvider(), ui, tools, permissions, "run the slow tool");

    expect(sizeDuringCall).toBe(1);
    expect(session.activeAbortControllers.size).toBe(0);
  });

  it("removes the controller even when the tool throws", async () => {
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    const tools = new ToolRegistry();
    tools.register({
      name: "slow_tool",
      description: "d",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      async handler() {
        throw new Error("boom");
      },
    });

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    await runTurn(session, new OneToolProvider(), ui, tools, permissions, "run the slow tool");

    expect(session.activeAbortControllers.size).toBe(0);
  });

  it("a controller registered on the session, once aborted, actually flips the tool's own ctx.signal.aborted — the real wiring Ctrl+C relies on", async () => {
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    let observedAborted: boolean | undefined;

    const tools = new ToolRegistry();
    tools.register({
      name: "slow_tool",
      description: "d",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      async handler(_input, ctx) {
        // Simulates cli.ts's registerShutdownHandlers: abort every
        // currently-active controller — this is the literal mechanism
        // Ctrl+C uses, exercised here without going through a real SIGINT.
        for (const controller of session.activeAbortControllers) controller.abort();
        observedAborted = ctx.signal.aborted;
        return { content: "ok", isError: false };
      },
    });

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    await runTurn(session, new OneToolProvider(), ui, tools, permissions, "run the slow tool");

    expect(observedAborted).toBe(true);
  });
});
