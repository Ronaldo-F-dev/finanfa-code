import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { HooksConfig } from "../../src/hooks/config.js";
import type { LlmProvider, StreamTurnResult, ToolDefinition } from "../../src/core/types.js";
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

class EmptyResponseProvider implements LlmProvider {
  async streamTurn(): Promise<StreamTurnResult> {
    return {
      assistantMessage: { role: "assistant", content: "" },
      usage: { inputTokens: 1, outputTokens: 0 },
      stopReason: "end_turn",
    };
  }
}

describe("runTurn: model returns an empty final response", () => {
  it("surfaces a system note instead of leaving the turn silent", async () => {
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new EmptyResponseProvider(), ui, new ToolRegistry(), permissions, "hello");

    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("empty response"));
  });

  it("does not warn when the assistant actually said something", async () => {
    class RealResponseProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        return {
          assistantMessage: { role: "assistant", content: "here you go" },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      }
    }

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new RealResponseProvider(), ui, new ToolRegistry(), permissions, "hello");

    expect(ui.writeSystem).not.toHaveBeenCalledWith(expect.stringContaining("empty response"));
  });
});

describe("runTurn: PostToolUse hook", () => {
  it("runs after a real tool call completes and surfaces the hook's output", async () => {
    let call = 0;
    class ToolCallThenDoneProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        call++;
        if (call === 1) {
          return {
            assistantMessage: { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "safe_tool", input: {} }] },
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

    const safeTool: ToolDefinition = {
      name: "safe_tool",
      description: "",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      handler: async () => ({ content: "tool ran", isError: false }),
    };

    const ui = makeStubUi();
    const hooksConfig: HooksConfig = { PostToolUse: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo hook-saw-it" }] }] };
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig });
    const tools = new ToolRegistry();
    tools.register(safeTool);
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new ToolCallThenDoneProvider(), ui, tools, permissions, "do the thing");

    expect(ui.writeSystem).toHaveBeenCalledWith("hook-saw-it");
  });
});

describe("runTurn: UserPromptSubmit hook", () => {
  it("blocks the prompt before the model is ever called, and records nothing in history", async () => {
    let providerCalled = false;
    class ShouldNeverBeCalledProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        providerCalled = true;
        throw new Error("must not be called");
      }
    }

    const ui = makeStubUi();
    const hooksConfig: HooksConfig = {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo '{\"decision\":\"block\",\"reason\":\"not right now\"}'" }] }],
    };
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new ShouldNeverBeCalledProvider(), ui, new ToolRegistry(), permissions, "do something");

    expect(providerCalled).toBe(false);
    expect(session.messages).toHaveLength(0);
    expect(ui.writeError).toHaveBeenCalledWith("not right now");
  });

  it("appends a hook's stdout as extra context the model sees alongside the real prompt", async () => {
    let capturedContent: string | undefined;
    class CapturingProvider implements LlmProvider {
      async streamTurn(params: { messages: { role: string; content?: string }[] }): Promise<StreamTurnResult> {
        const lastMessage = params.messages[params.messages.length - 1];
        capturedContent ??= lastMessage && "content" in lastMessage ? lastMessage.content : undefined;
        return { assistantMessage: { role: "assistant", content: "ok" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
    }

    const ui = makeStubUi();
    const hooksConfig: HooksConfig = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo extra-context-here" }] }] };
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new CapturingProvider(), ui, new ToolRegistry(), permissions, "the real question");

    expect(capturedContent).toContain("the real question");
    expect(capturedContent).toContain("extra-context-here");
  });
});
