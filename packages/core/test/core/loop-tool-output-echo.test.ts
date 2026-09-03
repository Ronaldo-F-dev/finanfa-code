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

function oneToolCallThenDone(toolName: string, called = { done: false }) {
  return class implements LlmProvider {
    async streamTurn(): Promise<StreamTurnResult> {
      if (!called.done) {
        called.done = true;
        return {
          assistantMessage: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: toolName, input: {} }] },
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
  };
}

describe("runTurn: tool output is echoed to the UI, not just the invocation line", () => {
  it("echoes a successful tool's content via writeSystem", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "noisy",
      description: "",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      handler: async () => ({ content: "build succeeded, 12 tests passed", isError: false }),
    });

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new (oneToolCallThenDone("noisy"))(), ui, tools, permissions, "run it");

    expect(ui.writeSystem).toHaveBeenCalledWith("build succeeded, 12 tests passed");
  });

  it("echoes a failing tool's content via writeError, not writeSystem", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "failing",
      description: "",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      handler: async () => ({ content: "TypeError: x is not a function", isError: true }),
    });

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new (oneToolCallThenDone("failing"))(), ui, tools, permissions, "run it");

    expect(ui.writeError).toHaveBeenCalledWith("TypeError: x is not a function");
    expect(ui.writeSystem).not.toHaveBeenCalledWith("TypeError: x is not a function");
  });

  it("truncates a very long tool output instead of dumping it all to the terminal", async () => {
    const long = "x".repeat(5000);
    const tools = new ToolRegistry();
    tools.register({
      name: "verbose",
      description: "",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      handler: async () => ({ content: long, isError: false }),
    });

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new (oneToolCallThenDone("verbose"))(), ui, tools, permissions, "run it");

    const echoed = (ui.writeSystem as ReturnType<typeof vi.fn>).mock.calls.find((c) => (c[0] as string).includes("x"))?.[0] as string;
    expect(echoed.length).toBeLessThan(5000);
    expect(echoed).toContain("(truncated)");
  });

  it("does not echo an empty result", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "silent",
      description: "",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      handler: async () => ({ content: "", isError: false }),
    });

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new (oneToolCallThenDone("silent"))(), ui, tools, permissions, "run it");

    expect(ui.writeSystem).not.toHaveBeenCalledWith("");
  });

  it("echoes a thrown exception's message via writeError", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "throws",
      description: "",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      handler: async () => {
        throw new Error("boom");
      },
    });

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new (oneToolCallThenDone("throws"))(), ui, tools, permissions, "run it");

    expect(ui.writeError).toHaveBeenCalledWith("boom");
  });
});
