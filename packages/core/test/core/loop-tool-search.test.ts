import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import { SEARCH_TOOLS_NAME, DESCRIBE_TOOL_NAME, CALL_TOOL_NAME } from "../../src/core/tool-search.js";
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
    description: "Read a file's contents",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    async handler(input: { path: string }) {
      return { content: `contents of ${input.path}`, isError: false };
    },
  });
  tools.register({
    name: "bash",
    description: "Run a shell command",
    riskLevel: "dangerous",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
    async handler() {
      return { content: "ran it", isError: false };
    },
  });
  return tools;
}

class CapturingProvider implements LlmProvider {
  offeredToolNames: string[] = [];
  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    this.offeredToolNames = params.tools.map((t) => t.name);
    return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
  }
}

/** A provider that calls a single tool (whatever's given) on its first turn, then ends. */
class OneShotToolCallProvider implements LlmProvider {
  calls = 0;
  constructor(private readonly toolCall: { id: string; name: string; input: unknown }) {}
  async streamTurn(): Promise<StreamTurnResult> {
    this.calls++;
    if (this.calls === 1) {
      return {
        assistantMessage: { role: "assistant", content: "", toolCalls: [this.toolCall] },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      };
    }
    return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
  }
}

describe("runTurn: Tool Search (session.toolSearchEnabled)", () => {
  it("offers the full tool list when Tool Search is off (default)", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    const provider = new CapturingProvider();

    await runTurn(session, provider, ui, tools, permissions, "hi");

    expect(provider.offeredToolNames.sort()).toEqual(["bash", "read_file"]);
  });

  it("offers only the 3 meta-tools when Tool Search is enabled, regardless of how many real tools are registered", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.toolSearchEnabled = true;
    const provider = new CapturingProvider();

    await runTurn(session, provider, ui, tools, permissions, "hi");

    expect(provider.offeredToolNames.sort()).toEqual([CALL_TOOL_NAME, DESCRIBE_TOOL_NAME, SEARCH_TOOLS_NAME]);
  });

  // Real, reported bug: disabling every tool from the Tools panel (to use a
  // model with no tool-calling support at all, e.g. medgemma) still sent a
  // non-empty `tools` request field — the 3 meta-tools themselves, always
  // attached whenever Tool Search is on regardless of how many real tools
  // are actually left — so a provider that flatly rejects `tools` on an
  // incompatible model failed anyway, "no tool enabled" in the UI
  // notwithstanding.
  it("offers NO tools at all (not even the meta-tools) when Tool Search is on but every real tool has been disabled", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.toolSearchEnabled = true;
    session.disabledTools.add("read_file");
    session.disabledTools.add("bash");
    const provider = new CapturingProvider();

    await runTurn(session, provider, ui, tools, permissions, "hi");

    expect(provider.offeredToolNames).toEqual([]);
  });

  it("call_tool actually runs the real target tool's handler and returns its real result", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.toolSearchEnabled = true;
    const provider = new OneShotToolCallProvider({ id: "c1", name: CALL_TOOL_NAME, input: { name: "read_file", input: { path: "a.txt" } } });

    await runTurn(session, provider, ui, tools, permissions, "read a.txt");

    const toolMsg = session.messages.find((m) => m.role === "tool");
    if (toolMsg?.role === "tool") {
      expect(toolMsg.results[0].isError).toBe(false);
      expect(toolMsg.results[0].content).toBe("contents of a.txt");
    } else {
      throw new Error("expected a tool message");
    }
  });

  it("call_tool routes through the SAME permission check the target tool's own riskLevel would trigger — a dangerous tool isn't auto-approved just because it went through call_tool", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    // nonInteractive: never prompts, auto-denies anything not pre-allowed — same fail-safe behavior a direct "bash" call would hit.
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, nonInteractive: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.toolSearchEnabled = true;
    const provider = new OneShotToolCallProvider({ id: "c1", name: CALL_TOOL_NAME, input: { name: "bash", input: { command: "echo hi" } } });

    await runTurn(session, provider, ui, tools, permissions, "run a command");

    const toolMsg = session.messages.find((m) => m.role === "tool");
    if (toolMsg?.role === "tool") {
      expect(toolMsg.results[0].isError).toBe(true);
      expect(toolMsg.results[0].content).toContain("declined");
    } else {
      throw new Error("expected a tool message");
    }
  });

  it("call_tool reports a clear error for an unknown target tool name, instead of throwing", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.toolSearchEnabled = true;
    const provider = new OneShotToolCallProvider({ id: "c1", name: CALL_TOOL_NAME, input: { name: "nonexistent_tool", input: {} } });

    await runTurn(session, provider, ui, tools, permissions, "call something bogus");

    const toolMsg = session.messages.find((m) => m.role === "tool");
    if (toolMsg?.role === "tool") {
      expect(toolMsg.results[0].isError).toBe(true);
      expect(toolMsg.results[0].content).toContain(SEARCH_TOOLS_NAME);
    } else {
      throw new Error("expected a tool message");
    }
  });

  it("call_tool cannot reach a tool this session has explicitly disabled, even naming it exactly", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.toolSearchEnabled = true;
    session.disabledTools.add("bash");
    const provider = new OneShotToolCallProvider({ id: "c1", name: CALL_TOOL_NAME, input: { name: "bash", input: { command: "echo hi" } } });

    await runTurn(session, provider, ui, tools, permissions, "run a command");

    const toolMsg = session.messages.find((m) => m.role === "tool");
    if (toolMsg?.role === "tool") {
      expect(toolMsg.results[0].isError).toBe(true);
      expect(toolMsg.results[0].content).toContain("disabled for this session");
    } else {
      throw new Error("expected a tool message");
    }
  });

  it("call_tool reports a clear error when 'name' is missing from its input", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.toolSearchEnabled = true;
    const provider = new OneShotToolCallProvider({ id: "c1", name: CALL_TOOL_NAME, input: {} });

    await runTurn(session, provider, ui, tools, permissions, "call something with no name");

    const toolMsg = session.messages.find((m) => m.role === "tool");
    if (toolMsg?.role === "tool") {
      expect(toolMsg.results[0].isError).toBe(true);
      expect(toolMsg.results[0].content).toContain('requires "name"');
    } else {
      throw new Error("expected a tool message");
    }
  });

  // Real bug found testing this against a real local model: search_tools/
  // describe_tool are (like call_tool) never actually registered on the
  // real ToolRegistry — only synthesized into the list sent to the model.
  // Without runOneToolCall's own special-case for them (added alongside
  // this test), calling search_tools reported "Unknown tool" every time,
  // and the model retried with a different query indefinitely, never
  // making any progress — confirmed directly, not a guess.
  it("the model calling search_tools directly (not via call_tool) actually works, not 'Unknown tool'", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.toolSearchEnabled = true;
    const provider = new OneShotToolCallProvider({ id: "c1", name: SEARCH_TOOLS_NAME, input: { query: "read a file" } });

    await runTurn(session, provider, ui, tools, permissions, "find a tool to read a file");

    const toolMsg = session.messages.find((m) => m.role === "tool");
    if (toolMsg?.role === "tool") {
      expect(toolMsg.results[0].isError).toBe(false);
      expect(toolMsg.results[0].content).toContain("read_file");
    } else {
      throw new Error("expected a tool message");
    }
  });

  it("the model calling describe_tool directly (not via call_tool) actually works, not 'Unknown tool'", async () => {
    const tools = makeTools();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.toolSearchEnabled = true;
    const provider = new OneShotToolCallProvider({ id: "c1", name: DESCRIBE_TOOL_NAME, input: { name: "read_file" } });

    await runTurn(session, provider, ui, tools, permissions, "describe read_file");

    const toolMsg = session.messages.find((m) => m.role === "tool");
    if (toolMsg?.role === "tool") {
      expect(toolMsg.results[0].isError).toBe(false);
      const parsed = JSON.parse(toolMsg.results[0].content);
      expect(parsed.name).toBe("read_file");
    } else {
      throw new Error("expected a tool message");
    }
  });
});
