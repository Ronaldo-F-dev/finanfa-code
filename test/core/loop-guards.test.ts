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

function registerCountingTool(tools: ToolRegistry) {
  let calls = 0;
  tools.register({
    name: "counter",
    description: "counts how many times it's called",
    riskLevel: "safe",
    inputSchema: { type: "object" },
    async handler() {
      calls++;
      return { content: "ok", isError: false };
    },
  });
  return () => calls;
}

describe("runTurn: loop guards", () => {
  it("stops after MAX_ITERATIONS (50) even if the model never emits a final answer", async () => {
    const tools = new ToolRegistry();
    let n = 0;
    tools.register({
      name: "vary",
      description: "always-different tool call, so the repetition guard never trips first",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      async handler() {
        return { content: "ok", isError: false };
      },
    });

    class NeverEndingProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        n++;
        return {
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: `c${n}`, name: "vary", input: { n } }],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
      }
    }

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new NeverEndingProvider(), ui, tools, permissions, "go forever");

    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("stopped after 50 steps"));
    // 50 iterations run the model, but the 51st is refused before calling it again.
    expect(n).toBe(50);

    // Not just shown in the terminal — recorded into history too, or the
    // model has no way to know on the next turn that this ended via the
    // guard rather than by actually finishing (a real, observed failure:
    // asked "did you finish?" right after a cutoff, the model confidently
    // said yes).
    const last = session.messages.at(-1);
    expect(last).toEqual({ role: "assistant", content: expect.stringContaining("stopped after 50 steps") });
  });

  it("stops after the same tool call batch repeats 3 times, without executing the 3rd repeat", async () => {
    const tools = new ToolRegistry();
    const getCalls = registerCountingTool(tools);

    class StuckProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        return {
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "counter", input: { same: true } }],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
      }
    }

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new StuckProvider(), ui, tools, permissions, "do the same thing forever");

    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("repeated 3 times in a row"));
    expect(getCalls()).toBe(2);

    // The 3rd repeat's assistant message (with its tool_calls) is in history,
    // but the calls themselves were never run — without a stub tool result,
    // that tool_use would have no matching tool_result, which a provider
    // like Anthropic rejects outright on the next request, breaking the
    // session from here on. And, same reasoning as the iteration-limit case,
    // a trailing assistant note so the model knows this wasn't a natural stop.
    const toolMessage = session.messages.at(-2);
    expect(toolMessage).toEqual({
      role: "tool",
      results: [{ toolCallId: "c1", content: expect.stringContaining("repetition guard"), isError: true }],
    });
    const last = session.messages.at(-1);
    expect(last).toEqual({ role: "assistant", content: expect.stringContaining("repeated 3 times in a row") });
  });

  it("does not trigger the repetition guard when consecutive tool calls differ", async () => {
    const tools = new ToolRegistry();
    const getCalls = registerCountingTool(tools);
    let n = 0;

    class VaryingProvider implements LlmProvider {
      async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
        n++;
        if (n > 5) {
          return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
        }
        return {
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: `c${n}`, name: "counter", input: { n } }],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
      }
    }

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new VaryingProvider(), ui, tools, permissions, "do 5 different things");

    expect(getCalls()).toBe(5);
    expect(ui.writeSystem).not.toHaveBeenCalledWith(expect.stringContaining("repeated"));
  });
});
