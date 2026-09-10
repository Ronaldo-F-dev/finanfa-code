import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import { createBashTool } from "../../src/tools/builtin/bash.js";
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

function oneToolCallThenDone(toolName: string, input: unknown) {
  const called = { done: false };
  return class implements LlmProvider {
    async streamTurn(): Promise<StreamTurnResult> {
      if (!called.done) {
        called.done = true;
        return {
          assistantMessage: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: toolName, input }] },
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

describe("runTurn: a tool call missing its schema's required fields is rejected before the handler runs", () => {
  // Real reported bug: when a provider's tool-call arguments fail to parse
  // (truncated/malformed JSON — a huge heredoc argument in the real
  // transcript), the provider layer falls back to `input = {}` for that
  // call and only logs a warning. Nothing validated `inputSchema.required`
  // against that fallback, so bash's handler ran with `command` undefined,
  // producing a real shell side effect ("undefined: command not found")
  // instead of a clean tool error — and since the model kept retrying the
  // same malformed call, it repeated identically until the loop guard gave
  // up and stopped the whole task.
  it("bash: {} (command missing) is denied with a clear message, the real shell handler never runs", async () => {
    const tools = new ToolRegistry();
    tools.register(createBashTool({ mode: "off" }));

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new (oneToolCallThenDone("bash", {}))(), ui, tools, permissions, "do something");

    // Unknown-tool-style rejections (see the "Unknown tool" case just above
    // this one in loop.ts) don't go through echoToolOutput either — they're
    // surfaced to the model via the tool_result in session.messages, which
    // is what actually matters here: the real shell handler must never run.
    const toolMessage = session.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const toolResult = (toolMessage as { results: Array<{ isError: boolean; content: string }> }).results[0];
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain("Missing required field(s)");
    expect(toolResult.content).toContain("command");
    // No real shell side effect: never a literal "command not found" from
    // the real handler actually running with an undefined command.
    expect(toolResult.content).not.toContain("command not found");
  });

  it("a tool call with all required fields present still reaches its handler normally", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "greet",
      description: "",
      riskLevel: "safe",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: async (input: { name: string }) => ({ content: `hello ${input.name}`, isError: false }),
    });

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new (oneToolCallThenDone("greet", { name: "world" }))(), ui, tools, permissions, "greet");

    expect(ui.writeSystem).toHaveBeenCalledWith("hello world");
  });
});
