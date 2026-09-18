import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import { SEARCH_TOOLS_NAME } from "../../src/core/tool-search.js";
import { LOCAL_MODEL_LEAN_EXCLUDED_TOOLS } from "../../src/core/local-model-lean.js";
import type { LlmProvider, StreamTurnParams, StreamTurnResult, NeutralToolCall } from "../../src/core/types.js";
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

function makeToolsWithBrowserAndBash(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "bash",
    description: "Run a shell command",
    riskLevel: "dangerous",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
    async handler() {
      return { content: "ran it", isError: false };
    },
  });
  tools.register({
    name: "browser_navigate",
    description: "Navigate a real headless browser to a URL",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
    async handler() {
      return { content: "navigated", isError: false };
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

// Real, reported motivation: a code investigation of OpenClaw (a comparable
// reference agent) found it strips exactly this category of tool (browser,
// automations, image/video/audio generation, PDF conversion, messaging
// channels) for local models, on top of Tool Search reducing the total
// schema count sent per turn — Tool Search alone still lets a local model
// discover and attempt any of these slow/credential-gated tools via
// search_tools.
describe("runTurn: localModelLeanEnabled excludes LOCAL_MODEL_LEAN_EXCLUDED_TOOLS", () => {
  it("never sends an excluded tool's schema when lean mode is on and Tool Search is off", async () => {
    const tools = makeToolsWithBrowserAndBash();
    const provider = new CapturingProvider();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.localModelLeanEnabled = true;

    await runTurn(session, provider, ui, tools, permissions, "hello");

    expect(provider.offeredToolNames).toContain("bash");
    expect(provider.offeredToolNames).not.toContain("browser_navigate");
  });

  it("sends every tool, including normally-excluded ones, when lean mode is off", async () => {
    const tools = makeToolsWithBrowserAndBash();
    const provider = new CapturingProvider();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.localModelLeanEnabled = false;

    await runTurn(session, provider, ui, tools, permissions, "hello");

    expect(provider.offeredToolNames).toContain("bash");
    expect(provider.offeredToolNames).toContain("browser_navigate");
  });

  it("a genuinely unreachable excluded tool: search_tools (Tool Search on, lean on) can never surface it, and call_tool refuses it directly", async () => {
    const tools = makeToolsWithBrowserAndBash();
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.toolSearchEnabled = true;
    session.localModelLeanEnabled = true;

    let searchResultContent = "";
    class SearchThenDoneProvider implements LlmProvider {
      calls = 0;
      async streamTurn(): Promise<StreamTurnResult> {
        this.calls++;
        if (this.calls === 1) {
          const toolCalls: NeutralToolCall[] = [{ id: "c1", name: SEARCH_TOOLS_NAME, input: { query: "browser navigate" } }];
          return {
            assistantMessage: { role: "assistant", content: "", toolCalls },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
        }
        return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
    }

    await runTurn(session, new SearchThenDoneProvider(), ui, tools, permissions, "hello");

    const toolMessage = session.messages.find((m) => m.role === "tool");
    if (toolMessage?.role === "tool") searchResultContent = toolMessage.results[0]?.content ?? "";
    expect(searchResultContent).not.toContain("browser_navigate");
  });
});

describe("LOCAL_MODEL_LEAN_EXCLUDED_TOOLS", () => {
  it("covers the real tool names this project actually registers for each excluded category", () => {
    for (const name of [
      "browser_navigate",
      "browser_screenshot",
      "browser_click",
      "browser_fill",
      "schedule_task",
      "generate_2d",
      "generate_3d",
      "text_to_speech",
      "transcribe_audio",
      "analyze_video",
      "convert_to_pdf",
      "send_slack_message",
      "send_telegram_message",
    ]) {
      expect(LOCAL_MODEL_LEAN_EXCLUDED_TOOLS.has(name)).toBe(true);
    }
  });

  it("does not exclude core file/shell/git tools", () => {
    for (const name of ["bash", "write_file", "read_file", "edit_file", "git_commit", "grep", "glob"]) {
      expect(LOCAL_MODEL_LEAN_EXCLUDED_TOOLS.has(name)).toBe(false);
    }
  });
});
