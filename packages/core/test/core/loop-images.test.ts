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

/** First call requests the "screenshot" tool; second call (after tool results) just finishes. */
class ScriptedProvider implements LlmProvider {
  callCount = 0;
  seenMessages: StreamTurnParams["messages"][] = [];

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    // Snapshot deeply — a real provider serializes the request onto the wire
    // synchronously before returning, but this test double just holds onto
    // the array/object references, which the loop legitimately mutates
    // afterward (stripping a consumed image from history). Without cloning,
    // that later mutation would retroactively change what this test
    // observes as "sent", which isn't what actually happens over HTTP.
    this.seenMessages.push(JSON.parse(JSON.stringify(params.messages)));
    this.callCount++;
    if (this.callCount === 1) {
      return {
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "screenshot", input: {} }],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      };
    }
    return {
      assistantMessage: { role: "assistant", content: "I can see the page." },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  }
}

describe("runTurn: images returned by a tool", () => {
  it("surfaces a tool's image as a follow-up user message the next provider call can see", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "screenshot",
      description: "fake screenshot tool",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      async handler() {
        return {
          content: "Saved screenshot",
          isError: false,
          images: [{ mimeType: "image/png", base64: "AAAA" }],
        };
      },
    });

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const provider = new ScriptedProvider();
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, provider, ui, tools, permissions, "take a screenshot");

    // The second streamTurn call (the one that produces the final answer) must
    // have actually received that image message in its conversation history.
    const secondCallMessages = provider.seenMessages[1];
    const sentImageMessage = secondCallMessages.find((m) => m.role === "user" && m.images?.length);
    expect(sentImageMessage).toBeDefined();
    if (sentImageMessage?.role === "user") {
      expect(sentImageMessage.images).toEqual([{ mimeType: "image/png", base64: "AAAA" }]);
    }

    // But once that one call is done, the image is stripped from history —
    // otherwise it would get resent, unchanged, on every later unrelated
    // call for the rest of the session (a real bug: on a model that can't
    // handle it, that means every subsequent turn fails forever, not just
    // the one that triggered it).
    const imageMessageAfter = session.messages.find((m) => m.role === "user" && m.images?.length);
    expect(imageMessageAfter).toBeUndefined();
  });

  it("does not add an image follow-up message when no tool returned images", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "no_image_tool",
      description: "returns plain text only",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      async handler() {
        return { content: "just text", isError: false };
      },
    });

    class PlainProvider implements LlmProvider {
      callCount = 0;
      async streamTurn(): Promise<StreamTurnResult> {
        this.callCount++;
        if (this.callCount === 1) {
          return {
            assistantMessage: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "no_image_tool", input: {} }],
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

    await runTurn(session, new PlainProvider(), ui, tools, permissions, "do something");

    const imageMessage = session.messages.find((m) => m.role === "user" && m.images?.length);
    expect(imageMessage).toBeUndefined();
  });
});
