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

const DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runTurn: parallel execution of safe tool calls", () => {
  it("runs multiple riskLevel:'safe' calls in the same batch concurrently, not sequentially", async () => {
    const tools = new ToolRegistry();
    const order: string[] = [];
    for (const name of ["safe_a", "safe_b", "safe_c"]) {
      tools.register({
        name,
        description: "slow safe tool",
        riskLevel: "safe",
        inputSchema: { type: "object" },
        async handler() {
          order.push(`${name}:start`);
          await sleep(DELAY_MS);
          order.push(`${name}:end`);
          return { content: name, isError: false };
        },
      });
    }

    class OneShotProvider implements LlmProvider {
      calls = 0;
      async streamTurn(): Promise<StreamTurnResult> {
        this.calls++;
        if (this.calls === 1) {
          return {
            assistantMessage: {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "c1", name: "safe_a", input: {} },
                { id: "c2", name: "safe_b", input: {} },
                { id: "c3", name: "safe_c", input: {} },
              ],
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

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    const started = Date.now();
    await runTurn(session, new OneShotProvider(), ui, tools, permissions, "do three slow safe things");
    const elapsed = Date.now() - started;

    // Sequential would take ~3*DELAY_MS; concurrent takes ~1*DELAY_MS. Generous
    // margin to avoid flakiness, but tight enough to actually catch a regression
    // back to sequential execution.
    expect(elapsed).toBeLessThan(DELAY_MS * 2);

    // All three must have started before any of them finished.
    const firstEndIndex = order.findIndex((e) => e.endsWith(":end"));
    const startsBeforeFirstEnd = order.slice(0, firstEndIndex).filter((e) => e.endsWith(":start")).length;
    expect(startsBeforeFirstEnd).toBe(3);
  });

  it("still runs an 'ask'/'dangerous' tool call strictly sequentially alongside safe ones", async () => {
    const tools = new ToolRegistry();
    const order: string[] = [];
    tools.register({
      name: "safe_one",
      description: "safe",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      async handler() {
        order.push("safe_one");
        return { content: "ok", isError: false };
      },
    });
    tools.register({
      name: "writer",
      description: "not safe",
      riskLevel: "ask",
      inputSchema: { type: "object" },
      async handler() {
        order.push("writer");
        return { content: "ok", isError: false };
      },
    });

    class OneShotProvider implements LlmProvider {
      calls = 0;
      async streamTurn(): Promise<StreamTurnResult> {
        this.calls++;
        if (this.calls === 1) {
          return {
            assistantMessage: {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "c1", name: "writer", input: {} },
                { id: "c2", name: "safe_one", input: {} },
              ],
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

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new OneShotProvider(), ui, tools, permissions, "write then read");

    // The non-safe tool runs first (in call order), sequentially, before the safe one.
    expect(order).toEqual(["writer", "safe_one"]);
  });
});
