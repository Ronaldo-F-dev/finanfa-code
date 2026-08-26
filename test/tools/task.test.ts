import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createTaskTool, SUBAGENT_SYSTEM_PROMPT } from "../../src/tools/builtin/task.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeStubUi(): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
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

/**
 * A scripted LlmProvider: the parent turn first requests two "task" tool
 * calls, then (once fed their results) finishes with plain text. Any call
 * using the sub-agent's system prompt just echoes its own user prompt back,
 * and records which tools it was offered (to verify "task" is excluded).
 */
class ScriptedProvider implements LlmProvider {
  parentCallCount = 0;
  capturedSubagentTools: string[] | undefined;

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    if (params.systemPrompt === SUBAGENT_SYSTEM_PROMPT) {
      this.capturedSubagentTools = params.tools.map((t) => t.name);
      const userPrompt = params.messages.find((m) => m.role === "user")?.content ?? "";
      return {
        assistantMessage: { role: "assistant", content: `done: ${userPrompt}` },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    }

    this.parentCallCount++;
    if (this.parentCallCount === 1) {
      return {
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "task", input: { prompt: "research A", description: "A" } },
            { id: "c2", name: "task", input: { prompt: "research B", description: "B" } },
          ],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      };
    }
    return {
      assistantMessage: { role: "assistant", content: "combined report" },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  }
}

describe("task tool (sub-agent delegation)", () => {
  it("runs multiple task calls, feeds their results back, and excludes 'task' from the sub-agent's own tools", async () => {
    const tools = new ToolRegistry();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const provider = new ScriptedProvider();
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "parent system prompt" });

    tools.register(createTaskTool({ provider, tools, permissions, ui, model: "test-model", cwd: "/tmp" }));

    await runTurn(session, provider, ui, tools, permissions, "do A and B");

    const toolResultMsg = session.messages.find((m) => m.role === "tool");
    expect(toolResultMsg?.role).toBe("tool");
    if (toolResultMsg?.role === "tool") {
      expect(toolResultMsg.results).toHaveLength(2);
      expect(toolResultMsg.results.map((r) => r.content).sort()).toEqual([
        "done: research A",
        "done: research B",
      ]);
      expect(toolResultMsg.results.every((r) => !r.isError)).toBe(true);
    }

    const last = session.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", content: "combined report" });

    expect(provider.capturedSubagentTools).toBeDefined();
    expect(provider.capturedSubagentTools).not.toContain("task");
  });
});
