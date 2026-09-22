import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import { OpenAiCompatibleProvider } from "../../src/providers/openai-compatible-provider.js";
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

function makeTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "search_tools",
    description: "Search for a tool",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
    async handler(input: { query: string; limit?: number }) {
      return { content: `found tools for "${input.query}" (limit ${input.limit ?? "none"})`, isError: false };
    },
  });
  return tools;
}

/** Fixed-text provider standing in for a local model — returns the given text once, then ends normally. */
class FixedTextProvider extends OpenAiCompatibleProvider {
  calls = 0;
  constructor(private readonly text: string) {
    super({ baseUrl: "http://localhost:11434/v1" });
  }
  async streamTurn(): Promise<StreamTurnResult> {
    this.calls++;
    if (this.calls === 1) {
      return { assistantMessage: { role: "assistant", content: this.text }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    }
    return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
  }
}

/** A non-openai-compatible provider (e.g. Anthropic) returning the same fixed text — used to prove the repair is gated to the local-model path. */
class FixedTextOtherProvider implements LlmProvider {
  calls = 0;
  constructor(private readonly text: string) {}
  async streamTurn(): Promise<StreamTurnResult> {
    this.calls++;
    if (this.calls === 1) {
      return { assistantMessage: { role: "assistant", content: this.text }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    }
    return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
  }
}

describe("runTurn: text-embedded <tool_call> repair (local small-model quirk)", () => {
  it(
    "real, reported case: a bare {\"name\": ..., \"arguments\": ...} immediately followed by a stray " +
      "</tool_call> (no opening tag) actually invokes the real tool, instead of leaving the raw JSON+tag " +
      "visible to the user",
    async () => {
      const tools = makeTools();
      const ui = makeStubUi();
      const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
      const session = new AgentSession({ cwd: "/tmp", model: "bonsai-1.7b", systemPrompt: "sys" });
      const text = '{"name": "search_tools", "arguments": {"query": "security testing", "limit": 5}}\n</tool_call>';
      const provider = new FixedTextProvider(text);

      await runTurn(session, provider, ui, tools, permissions, "find a security tool");

      const toolMsg = session.messages.find((m) => m.role === "tool");
      if (toolMsg?.role === "tool") {
        expect(toolMsg.results[0].isError).toBe(false);
        expect(toolMsg.results[0].content).toBe('found tools for "security testing" (limit 5)');
      } else {
        throw new Error("expected a tool message — the tool call was never actually invoked");
      }

      const assistantMsg = session.messages.find((m) => m.role === "assistant");
      if (assistantMsg?.role === "assistant") {
        expect(assistantMsg.content).not.toContain("tool_call");
        expect(assistantMsg.content).not.toContain("search_tools");
      } else {
        throw new Error("expected an assistant message");
      }
    },
  );

  it("the full <tool_call>{...}</tool_call> wrapped variant also works", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "bonsai-1.7b", systemPrompt: "sys" });
    const text = 'Sure, let me look that up.\n<tool_call>{"name": "search_tools", "arguments": {"query": "security testing", "limit": 5}}</tool_call>';
    const provider = new FixedTextProvider(text);

    await runTurn(session, provider, ui, tools, permissions, "find a security tool");

    const toolMsg = session.messages.find((m) => m.role === "tool");
    if (toolMsg?.role === "tool") {
      expect(toolMsg.results[0].isError).toBe(false);
      expect(toolMsg.results[0].content).toBe('found tools for "security testing" (limit 5)');
    } else {
      throw new Error("expected a tool message — the tool call was never actually invoked");
    }

    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    if (assistantMsg?.role === "assistant") {
      expect(assistantMsg.content).toBe("Sure, let me look that up.");
    } else {
      throw new Error("expected an assistant message");
    }
  });

  it("a response with no <tool_call> pattern at all is completely unaffected", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "bonsai-1.7b", systemPrompt: "sys" });
    const provider = new FixedTextProvider("Here's a plain, ordinary answer with no tool call in it at all.");

    await runTurn(session, provider, ui, tools, permissions, "hi");

    expect(session.messages.some((m) => m.role === "tool")).toBe(false);
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    if (assistantMsg?.role === "assistant") {
      expect(assistantMsg.content).toBe("Here's a plain, ordinary answer with no tool call in it at all.");
    } else {
      throw new Error("expected an assistant message");
    }
  });

  it("legitimate JSON in prose that isn't anchored by a tool_call tag is left alone (no false positive)", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "bonsai-1.7b", systemPrompt: "sys" });
    const text = 'Here is the shape I mean: {"name": "search_tools", "arguments": {"query": "x"}} — that\'s just an example, not a real call.';
    const provider = new FixedTextProvider(text);

    await runTurn(session, provider, ui, tools, permissions, "explain the shape");

    expect(session.messages.some((m) => m.role === "tool")).toBe(false);
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    if (assistantMsg?.role === "assistant") {
      expect(assistantMsg.content).toBe(text);
    } else {
      throw new Error("expected an assistant message");
    }
  });

  it("the repair never triggers for a non-openai-compatible provider (e.g. Anthropic) — reliable structured tool-calling never needs this workaround", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "claude-x", systemPrompt: "sys" });
    const text = '{"name": "search_tools", "arguments": {"query": "security testing", "limit": 5}}\n</tool_call>';
    const provider = new FixedTextOtherProvider(text);

    await runTurn(session, provider, ui, tools, permissions, "find a security tool");

    expect(session.messages.some((m) => m.role === "tool")).toBe(false);
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    if (assistantMsg?.role === "assistant") {
      expect(assistantMsg.content).toBe(text);
    } else {
      throw new Error("expected an assistant message");
    }
  });
});
