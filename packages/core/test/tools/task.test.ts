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
    // runTurn appends the current date to whatever system prompt it's given
    // (see systemPromptWithDate in core/loop.ts), so this is no longer an
    // exact match — just a prefix check for "is this the sub-agent's prompt".
    if (params.systemPrompt.startsWith(SUBAGENT_SYSTEM_PROMPT)) {
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

  it("marks the task result as isError when the sub-agent hits the repetition guard, instead of always false", async () => {
    // A sub-agent stuck calling the same tool forever — enough to trip
    // checkRepetition's REPEAT_LIMIT (3), never enough to finish naturally.
    class StuckSubagentProvider implements LlmProvider {
      parentCallCount = 0;
      async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
        if (params.systemPrompt.startsWith(SUBAGENT_SYSTEM_PROMPT)) {
          return {
            assistantMessage: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "stuck", name: "noop", input: {} }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
        }
        this.parentCallCount++;
        if (this.parentCallCount === 1) {
          return {
            assistantMessage: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "task", input: { prompt: "get stuck" } }],
            },
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

    const tools = new ToolRegistry();
    tools.register({
      name: "noop",
      description: "",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      handler: async () => ({ content: "ok", isError: false }),
    });
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const provider = new StuckSubagentProvider();
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "parent system prompt" });

    tools.register(createTaskTool({ provider, tools, permissions, ui, model: "test-model", cwd: "/tmp" }));

    await runTurn(session, provider, ui, tools, permissions, "delegate the stuck task");

    const toolResultMsg = session.messages.find((m) => m.role === "tool");
    expect(toolResultMsg?.role).toBe("tool");
    if (toolResultMsg?.role === "tool") {
      expect(toolResultMsg.results[0].isError).toBe(true);
      expect(toolResultMsg.results[0].content).toContain("repeated");
    }
  });

  it("uses a custom agentType's own system prompt instead of the generic default", async () => {
    const CUSTOM_PROMPT = "You are the explorer subagent — read-only, never modify anything.";
    let capturedSystemPrompt: string | undefined;
    class Provider implements LlmProvider {
      async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
        capturedSystemPrompt ??= params.systemPrompt;
        return { assistantMessage: { role: "assistant", content: "explored" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
    }

    const tools = new ToolRegistry();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const provider = new Provider();
    const taskTool = createTaskTool({
      provider,
      tools,
      permissions,
      ui,
      model: "test-model",
      cwd: "/tmp",
      agentTypes: [{ name: "explorer", description: "Read-only exploration", systemPrompt: CUSTOM_PROMPT, scope: "project" }],
    });

    const result = await taskTool.handler({ prompt: "look around", agentType: "explorer" }, {
      cwd: "/tmp",
      sessionId: "s",
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(capturedSystemPrompt).toContain(CUSTOM_PROMPT);
  });

  it("restricts the sub-agent to an agentType's tool whitelist", async () => {
    let capturedTools: string[] | undefined;
    class Provider implements LlmProvider {
      async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
        capturedTools ??= params.tools.map((t) => t.name);
        return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
    }

    const tools = new ToolRegistry();
    tools.register({ name: "read_file", description: "", riskLevel: "safe", inputSchema: { type: "object" }, handler: async () => ({ content: "", isError: false }) });
    tools.register({ name: "write_file", description: "", riskLevel: "ask", inputSchema: { type: "object" }, handler: async () => ({ content: "", isError: false }) });
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const provider = new Provider();
    const taskTool = createTaskTool({
      provider,
      tools,
      permissions,
      ui,
      model: "test-model",
      cwd: "/tmp",
      agentTypes: [{ name: "explorer", description: "Read-only", systemPrompt: "explore only", tools: ["read_file"], scope: "project" }],
    });

    await taskTool.handler({ prompt: "look around", agentType: "explorer" }, { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal });

    expect(capturedTools).toContain("read_file");
    expect(capturedTools).not.toContain("write_file");
  });

  it("falls back to the generic default when agentType names an unknown type", async () => {
    let capturedSystemPrompt: string | undefined;
    class Provider implements LlmProvider {
      async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
        capturedSystemPrompt ??= params.systemPrompt;
        return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
    }

    const tools = new ToolRegistry();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const taskTool = createTaskTool({ provider: new Provider(), tools, permissions, ui, model: "test-model", cwd: "/tmp" });

    await taskTool.handler({ prompt: "do something", agentType: "not_a_real_type" }, { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal });

    expect(capturedSystemPrompt).toContain(SUBAGENT_SYSTEM_PROMPT);
  });

  it("mentions available agentType values in the tool description", () => {
    const tools = new ToolRegistry();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const taskTool = createTaskTool({
      provider: {} as LlmProvider,
      tools,
      permissions,
      ui,
      model: "test-model",
      cwd: "/tmp",
      agentTypes: [{ name: "explorer", description: "Read-only exploration", systemPrompt: "x", scope: "project" }],
    });

    expect(taskTool.description).toContain("explorer");
    expect(taskTool.description).toContain("Read-only exploration");
  });

  it("includes the agentType name in describeCall", () => {
    const tools = new ToolRegistry();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const taskTool = createTaskTool({ provider: {} as LlmProvider, tools, permissions, ui, model: "test-model", cwd: "/tmp" });

    expect(taskTool.describeCall!({ prompt: "do X", agentType: "explorer" })).toContain("(explorer)");
    expect(taskTool.describeCall!({ prompt: "do X" })).not.toContain("(");
  });
});
