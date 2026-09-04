import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { LlmProvider, StreamTurnResult } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeStubUi(): UIAdapter & { writeMedia: ReturnType<typeof vi.fn> } {
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
    writeMedia: vi.fn(),
    close: vi.fn(),
  };
}

class ScriptedProvider implements LlmProvider {
  callCount = 0;
  async streamTurn(): Promise<StreamTurnResult> {
    this.callCount++;
    if (this.callCount === 1) {
      return {
        assistantMessage: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "speak", input: {} }] },
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

describe("runTurn: media returned by a tool (e.g. text_to_speech)", () => {
  it(
    "fires the live UI event AND persists it onto the tool-result message — real bug: only the live event " +
      "existed before, so the audio player disappeared on reload since nothing was in session.messages",
    async () => {
      const tools = new ToolRegistry();
      tools.register({
        name: "speak",
        description: "fake TTS tool",
        riskLevel: "safe",
        inputSchema: { type: "object" },
        async handler() {
          return {
            content: "Wrote speech audio to out.mp3",
            isError: false,
            media: { kind: "audio", path: "out.mp3", mimeType: "audio/mpeg" },
          };
        },
      });

      const ui = makeStubUi();
      const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
      const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

      await runTurn(session, new ScriptedProvider(), ui, tools, permissions, "say hello");

      expect(ui.writeMedia).toHaveBeenCalledWith({ kind: "audio", path: "out.mp3", mimeType: "audio/mpeg" });

      const toolMessage = session.messages.find((m) => m.role === "tool");
      expect(toolMessage).toBeDefined();
      if (toolMessage?.role === "tool") {
        expect(toolMessage.results[0].media).toEqual({ kind: "audio", path: "out.mp3", mimeType: "audio/mpeg" });
      }
    },
  );

  it("does not persist media for a failed tool call", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "speak",
      description: "fake TTS tool that fails",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      async handler() {
        return { content: "failed", isError: true, media: { kind: "audio" as const, path: "out.mp3", mimeType: "audio/mpeg" } };
      },
    });

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new ScriptedProvider(), ui, tools, permissions, "say hello");

    expect(ui.writeMedia).not.toHaveBeenCalled();
    const toolMessage = session.messages.find((m) => m.role === "tool");
    if (toolMessage?.role === "tool") {
      expect(toolMessage.results[0].media).toBeUndefined();
    }
  });
});
