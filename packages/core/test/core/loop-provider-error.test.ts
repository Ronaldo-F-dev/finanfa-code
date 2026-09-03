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

    // The image must not linger in history — see the next test for why.
    const stillHasImage = session.messages.some((m) => m.role === "user" && m.images?.length);
    expect(stillHasImage).toBe(false);
  });

  it(
    "real, reported bug: a failed image call must not keep breaking every later, unrelated turn in the session",
    async () => {
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

      class ImageOnceThenFineProvider implements LlmProvider {
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
          if (this.calls === 2) {
            // The follow-up call that's supposed to see the screenshot — this model can't.
            throw new Error("This model does not support multimodal (image/video/audio) inputs.");
          }
          // A later, completely unrelated turn — must succeed now that the
          // image has been dropped from history, not fail with the same error.
          return {
            assistantMessage: { role: "assistant", content: "sure, here's the CSS fix" },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "end_turn",
          };
        }
      }

      const ui = makeStubUi();
      const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
      const session = new AgentSession({ cwd: "/tmp", model: "poolside/laguna-s-2.1", systemPrompt: "sys" });
      const provider = new ImageOnceThenFineProvider();

      await runTurn(session, provider, ui, tools, permissions, "take a screenshot");
      (ui.writeSystem as ReturnType<typeof vi.fn>).mockClear();

      // A brand new, unrelated turn afterward.
      await runTurn(session, provider, ui, tools, permissions, "ok forget the screenshot, fix the CSS instead");

      expect(ui.writeSystem).not.toHaveBeenCalledWith(expect.stringContaining("doesn't support image input"));
      const last = session.messages.at(-1);
      expect(last).toMatchObject({ role: "assistant", content: "sure, here's the CSS fix" });
    },
  );

  it(
    "real, reported bug: unwraps a fetch TypeError's .cause instead of surfacing the useless " +
      '"fetch failed" alone',
    async () => {
      class NetworkFailureProvider implements LlmProvider {
        async streamTurn(): Promise<StreamTurnResult> {
          // Matches Node's real shape exactly (verified directly against a
          // genuine DNS failure): a bare fetch() throws a TypeError whose own
          // .message is always literally "fetch failed" — the actually
          // useful detail is one level down in .cause.
          throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND inference.poolside.ai") });
        }
      }

      const ui = makeStubUi();
      const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
      const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

      await runTurn(session, new NetworkFailureProvider(), ui, new ToolRegistry(), permissions, "hello");

      expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("getaddrinfo ENOTFOUND"));
    },
  );

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

  it.each([
    "This model's maximum context length is 128000 tokens, however you requested 145213 tokens.",
    "context_length_exceeded",
    "prompt is too long: 210004 tokens > 200000 maximum",
    "Please reduce the length of the messages.",
  ])(
    "gives an actionable /clear-or-/session message, not the raw error alone, for a real context-length wording: %s",
    async (providerMessage) => {
      class FailingProvider implements LlmProvider {
        async streamTurn(): Promise<StreamTurnResult> {
          throw new Error(providerMessage);
        }
      }

      const ui = makeStubUi();
      const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
      const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

      await runTurn(session, new FailingProvider(), ui, new ToolRegistry(), permissions, "hello");

      expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("context-length error"));
      expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("/clear"));
      expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("/session"));
      expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining(providerMessage));
    },
  );

  it("does not misclassify an ordinary error as a context-length one", async () => {
    class FailingProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        throw new Error("Internal server error, please retry.");
      }
    }

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new FailingProvider(), ui, new ToolRegistry(), permissions, "hello");

    expect(ui.writeSystem).not.toHaveBeenCalledWith(expect.stringContaining("context-length error"));
  });
});
