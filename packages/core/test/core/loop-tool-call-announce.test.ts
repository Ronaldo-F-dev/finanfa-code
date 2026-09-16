import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { LlmProvider, StreamTurnResult, ToolDefinition } from "../../src/core/types.js";
import type { UIAdapter, ToolCallAnnouncement } from "../../src/ui/adapter.js";

function makeStubUi(overrides: Partial<UIAdapter> = {}): UIAdapter {
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
    ...overrides,
  };
}

function oneToolCallThenDone(toolName: string) {
  let called = false;
  return class implements LlmProvider {
    async streamTurn(): Promise<StreamTurnResult> {
      if (!called) {
        called = true;
        return {
          assistantMessage: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: toolName, input: {} }] },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
      }
      return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    }
  };
}

const dangerousTool: ToolDefinition = {
  name: "bash",
  description: "",
  riskLevel: "dangerous",
  inputSchema: { type: "object" },
  describeCall: () => "rm -rf /tmp/x",
  handler: async () => ({ content: "ok", isError: false }),
};

describe("runTurn: announces a tool call via writeToolCall when the adapter supports it", () => {
  it("calls ui.writeToolCall with the tool name, description, and risk level instead of writeSystem", async () => {
    const writeToolCall = vi.fn();
    const ui = makeStubUi({ writeToolCall });
    const tools = new ToolRegistry();
    tools.register(dangerousTool);
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new (oneToolCallThenDone("bash"))(), ui, tools, permissions, "delete it");

    expect(writeToolCall).toHaveBeenCalledWith({ toolCallId: "c1", toolName: "bash", description: "rm -rf /tmp/x", riskLevel: "dangerous" } satisfies ToolCallAnnouncement);
    expect(ui.writeSystem).not.toHaveBeenCalledWith(expect.stringContaining("→"));
  });

  it("falls back to writeSystem with the old '→ tool: description' format when the adapter has no writeToolCall", async () => {
    const ui = makeStubUi(); // no writeToolCall — same shape every existing UIAdapter fake in this test suite already has
    const tools = new ToolRegistry();
    tools.register(dangerousTool);
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new (oneToolCallThenDone("bash"))(), ui, tools, permissions, "delete it");

    expect(ui.writeSystem).toHaveBeenCalledWith("→ bash: rm -rf /tmp/x");
  });
});
