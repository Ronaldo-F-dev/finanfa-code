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

class RecordingProvider implements LlmProvider {
  calls: string[] = [];
  private step = 0;

  constructor(private readonly script: StreamTurnResult[]) {}

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    this.calls.push(params.model);
    return this.script[this.step++];
  }
}

describe("runTurn: vision routing", () => {
  it("routes only the call right after a tool returns an image to the vision provider", async () => {
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

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "primary-model", systemPrompt: "sys" });

    const primary = new RecordingProvider([
      {
        assistantMessage: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "screenshot", input: {} }] },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      },
      { assistantMessage: { role: "assistant", content: "all done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
    ]);
    const vision = new RecordingProvider([
      { assistantMessage: { role: "assistant", content: "I can see the screenshot." }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
    ]);

    await runTurn(session, primary, ui, tools, permissions, "take a screenshot", {
      provider: vision,
      model: "vision-model",
    });

    expect(primary.calls).toEqual(["primary-model"]);
    expect(vision.calls).toEqual(["vision-model"]);

    // A second, unrelated turn afterwards must not stay pinned to the vision model.
    await runTurn(session, primary, ui, tools, permissions, "what's next?", { provider: vision, model: "vision-model" });
    expect(primary.calls).toEqual(["primary-model", "primary-model"]);
    expect(vision.calls).toEqual(["vision-model"]);
  });

  it("falls back to the primary provider when no visionRoute is configured, even with images", async () => {
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

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "primary-model", systemPrompt: "sys" });

    const primary = new RecordingProvider([
      {
        assistantMessage: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "screenshot", input: {} }] },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      },
      { assistantMessage: { role: "assistant", content: "I saw it (no vision route configured)." }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
    ]);

    await runTurn(session, primary, ui, tools, permissions, "take a screenshot");

    expect(primary.calls).toEqual(["primary-model", "primary-model"]);
  });
});
