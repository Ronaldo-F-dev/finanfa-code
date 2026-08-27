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

describe("runTurn: a provider call that throws ends the turn cleanly instead of propagating", () => {
  it("surfaces a plain system message for a generic provider failure", async () => {
    class FailingProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        throw new Error("OpenAI-compatible API error (500): server exploded");
      }
    }

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await expect(
      runTurn(session, new FailingProvider(), ui, new ToolRegistry(), permissions, "hello"),
    ).resolves.toBeUndefined();

    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("server exploded"));
    expect(ui.setBusy).toHaveBeenLastCalledWith(false);
  });

  it("gives a vision-specific explanation when the failing call was sending an image with no vision route configured", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "screenshot",
      description: "fake screenshot tool",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      async handler() {
        return { content: "Saved screenshot", isError: false, images: [{ mimeType: "image/png", base64: "AAAA" }] };
      },
    });

    class FirstCallOk implements LlmProvider {
      calls = 0;
      async streamTurn(): Promise<StreamTurnResult> {
        this.calls++;
        if (this.calls === 1) {
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
        throw new Error('{"error":{"message":"This model does not support multimodal (image/video/audio) inputs."}}');
      }
    }

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "poolside/laguna-s-2.1", systemPrompt: "sys" });

    // No visionRoute passed — matches the real reported bug.
    await runTurn(session, new FirstCallOk(), ui, tools, permissions, "take a screenshot");

    const call = (ui.writeSystem as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes("doesn't support image input"),
    );
    expect(call).toBeDefined();
    expect(String(call?.[0])).toContain("poolside/laguna-s-2.1");
    expect(String(call?.[0])).toContain("Vision routing");
  });

  it("does not falsely blame vision when the failure is unrelated to an image call", async () => {
    class FailingProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        throw new Error("network timeout");
      }
    }

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new FailingProvider(), ui, new ToolRegistry(), permissions, "hello");

    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("network timeout"));
    expect(ui.writeSystem).not.toHaveBeenCalledWith(expect.stringContaining("Vision routing"));
  });
});
