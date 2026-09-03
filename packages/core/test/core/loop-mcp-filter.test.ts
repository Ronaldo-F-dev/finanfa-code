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

function makeTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "read_file",
    description: "builtin",
    riskLevel: "safe",
    inputSchema: { type: "object" },
    async handler() {
      return { content: "ok", isError: false };
    },
  });
  tools.register({
    name: "mcp__github__list_issues",
    description: "github MCP tool",
    riskLevel: "ask",
    inputSchema: { type: "object" },
    async handler() {
      return { content: "ok", isError: false };
    },
  });
  tools.register({
    name: "mcp__notion__search",
    description: "notion MCP tool",
    riskLevel: "ask",
    inputSchema: { type: "object" },
    async handler() {
      return { content: "ok", isError: false };
    },
  });
  return tools;
}

class CapturingProvider implements LlmProvider {
  offeredToolNames: string[] = [];
  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    this.offeredToolNames = params.tools.map((t) => t.name);
    return {
      assistantMessage: { role: "assistant", content: "done" },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  }
}

describe("runTurn: disabled MCP servers are excluded from the tools offered to the model", () => {
  it("offers every tool when nothing is disabled", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    const provider = new CapturingProvider();

    await runTurn(session, provider, ui, tools, permissions, "hi");

    expect(provider.offeredToolNames.sort()).toEqual(["mcp__github__list_issues", "mcp__notion__search", "read_file"]);
  });

  it("excludes only the disabled server's tools, keeping built-ins and other servers", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.disabledMcpServers.add("notion");
    const provider = new CapturingProvider();

    await runTurn(session, provider, ui, tools, permissions, "hi");

    expect(provider.offeredToolNames.sort()).toEqual(["mcp__github__list_issues", "read_file"]);
  });

  it("a disabled tool can still be executed if somehow called — disabling only affects what's offered", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.disabledMcpServers.add("notion");

    class OneShotProvider implements LlmProvider {
      calls = 0;
      async streamTurn(): Promise<StreamTurnResult> {
        this.calls++;
        if (this.calls === 1) {
          return {
            assistantMessage: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "mcp__notion__search", input: {} }],
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

    await runTurn(session, new OneShotProvider(), ui, tools, permissions, "call notion anyway");

    const toolMsg = session.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role).toBe("tool");
    if (toolMsg?.role === "tool") {
      expect(toolMsg.results[0].isError).toBe(false);
      expect(toolMsg.results[0].content).toBe("ok");
    }
  });
});
