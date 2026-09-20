import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { HooksConfig } from "../../src/hooks/config.js";
import type { LlmProvider, StreamTurnResult, ToolDefinition } from "../../src/core/types.js";
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

class EmptyResponseProvider implements LlmProvider {
  async streamTurn(): Promise<StreamTurnResult> {
    return {
      assistantMessage: { role: "assistant", content: "" },
      usage: { inputTokens: 1, outputTokens: 0 },
      stopReason: "end_turn",
    };
  }
}

describe("runTurn: model returns an empty final response", () => {
  it("surfaces a system note instead of leaving the turn silent", async () => {
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new EmptyResponseProvider(), ui, new ToolRegistry(), permissions, "hello");

    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("empty response"));
  });

  it("does not warn when the assistant actually said something", async () => {
    class RealResponseProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        return {
          assistantMessage: { role: "assistant", content: "here you go" },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      }
    }

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new RealResponseProvider(), ui, new ToolRegistry(), permissions, "hello");

    expect(ui.writeSystem).not.toHaveBeenCalledWith(expect.stringContaining("empty response"));
  });
});

// Real, reported failure across several small local models tested through
// this project's own tool pipeline: instead of a real structured
// tool_calls entry, the model writes its intended call as plain text — and
// its own following sentences confidently claim success for something
// that never happened (verified directly more than once: zero files
// existed on disk despite "J'ai créé les fichiers via write_file...").
describe("runTurn: a model that writes a fake tool call as plain text instead of a real one", () => {
  function fakeCallProvider(content: string): LlmProvider {
    return {
      async streamTurn(): Promise<StreamTurnResult> {
        return { assistantMessage: { role: "assistant", content }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      },
    };
  }

  it.each([
    // Real, reported wording from qwen2.5-coder:3b via finanfa's raw OpenAI-compatible request.
    '{"name": "bash", "arguments": {"command":{"type":"string","value":"ls"}}}',
    // Real, reported wording from qwen2.5-coder:7b — made-up field names, not even the real write_file schema.
    '{"name": "write_file", "arguments": {"file": "/tmp/go.mod", "contents": "module go_project"}}',
    // Real, reported wording from qwen2.5-coder:3b through finanfa's actual REPL — a made-up action schema, unquoted keys.
    '{action: "create_project"} {action: "create_file", path: "/tmp/go.mod", input: "module go_test"}',
    // Real, reported wording from ducquoc/gemma4-fast-sonnet, through the
    // mobile client's real WebSocket connection: asked an ordinary question
    // completely unrelated to any file, the model answered with only this
    // fenced block and nothing else — a Gemini-style ```tool_code
    // convention this project never taught it, so the earlier JSON-only
    // pattern (which requires the trimmed text to start with "{") never
    // matched a fenced code block at all, and the user saw total silence.
    '```tool_code\nread_file("/Users/renaldo/Desktop/finanfa-code/packages/web-server/src/app/app.component.ts")\n```',
  ])("flags it instead of silently accepting it as a normal response: %s", async (content) => {
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, fakeCallProvider(content), ui, new ToolRegistry(), permissions, "hello");

    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("tried to call a tool by writing it as plain text"));
  });

  it("does not flag an ordinary text response that happens to mention JSON mid-sentence", async () => {
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(
      session,
      fakeCallProvider(
        'Bien sûr ! Un exemple de réponse JSON ressemble à {"name": "value"} — voulez-vous que je vous explique comment le parser ?',
      ),
      ui,
      new ToolRegistry(),
      permissions,
      "hello",
    );

    expect(ui.writeSystem).not.toHaveBeenCalledWith(expect.stringContaining("tried to call a tool by writing it as plain text"));
  });

  it("does not flag a real fenced code example that isn't just a single bare function call", async () => {
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(
      session,
      fakeCallProvider('Voici un exemple :\n```python\ndef add(a, b):\n    return a + b\n```\nAppelez `add(1, 2)` pour tester.'),
      ui,
      new ToolRegistry(),
      permissions,
      "hello",
    );

    expect(ui.writeSystem).not.toHaveBeenCalledWith(expect.stringContaining("tried to call a tool by writing it as plain text"));
  });

  it("does not flag a real, normal response with no JSON at all", async () => {
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, fakeCallProvider("Voici votre réponse : la somme est 8."), ui, new ToolRegistry(), permissions, "hello");

    expect(ui.writeSystem).not.toHaveBeenCalledWith(expect.stringContaining("tried to call a tool by writing it as plain text"));
  });
});

describe("runTurn: PostToolUse hook", () => {
  it("runs after a real tool call completes and surfaces the hook's output", async () => {
    let call = 0;
    class ToolCallThenDoneProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        call++;
        if (call === 1) {
          return {
            assistantMessage: { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "safe_tool", input: {} }] },
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

    const safeTool: ToolDefinition = {
      name: "safe_tool",
      description: "",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      handler: async () => ({ content: "tool ran", isError: false }),
    };

    const ui = makeStubUi();
    const hooksConfig: HooksConfig = { PostToolUse: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo hook-saw-it" }] }] };
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig });
    const tools = new ToolRegistry();
    tools.register(safeTool);
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new ToolCallThenDoneProvider(), ui, tools, permissions, "do the thing");

    expect(ui.writeSystem).toHaveBeenCalledWith("hook-saw-it");
  });
});

describe("runTurn: UserPromptSubmit hook", () => {
  it("blocks the prompt before the model is ever called, and records nothing in history", async () => {
    let providerCalled = false;
    class ShouldNeverBeCalledProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        providerCalled = true;
        throw new Error("must not be called");
      }
    }

    const ui = makeStubUi();
    const hooksConfig: HooksConfig = {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo '{\"decision\":\"block\",\"reason\":\"not right now\"}'" }] }],
    };
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new ShouldNeverBeCalledProvider(), ui, new ToolRegistry(), permissions, "do something");

    expect(providerCalled).toBe(false);
    expect(session.messages).toHaveLength(0);
    expect(ui.writeError).toHaveBeenCalledWith("not right now");
  });

  it("appends a hook's stdout as extra context the model sees alongside the real prompt", async () => {
    let capturedContent: string | undefined;
    class CapturingProvider implements LlmProvider {
      async streamTurn(params: { messages: { role: string; content?: string }[] }): Promise<StreamTurnResult> {
        const lastMessage = params.messages[params.messages.length - 1];
        capturedContent ??= lastMessage && "content" in lastMessage ? lastMessage.content : undefined;
        return { assistantMessage: { role: "assistant", content: "ok" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
    }

    const ui = makeStubUi();
    const hooksConfig: HooksConfig = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo extra-context-here" }] }] };
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    await runTurn(session, new CapturingProvider(), ui, new ToolRegistry(), permissions, "the real question");

    expect(capturedContent).toContain("the real question");
    expect(capturedContent).toContain("extra-context-here");
  });
});

describe("runTurn: plan mode", () => {
  function makeToolCallThenDoneProvider(toolName: string, toolInput: unknown) {
    let call = 0;
    class Provider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        call++;
        if (call === 1) {
          return {
            assistantMessage: { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: toolName, input: toolInput }] },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
        }
        return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
    }
    return new Provider();
  }

  it("auto-denies a mutating tool without ever calling it or prompting, while plan mode is on", async () => {
    let handlerCalled = false;
    const dangerousTool: ToolDefinition = {
      name: "write_file",
      description: "",
      riskLevel: "dangerous",
      inputSchema: { type: "object" },
      handler: async () => {
        handlerCalled = true;
        return { content: "wrote", isError: false };
      },
    };

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const tools = new ToolRegistry();
    tools.register(dangerousTool);
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.planMode = true;

    await runTurn(session, makeToolCallThenDoneProvider("write_file", {}), ui, tools, permissions, "do the thing");

    expect(handlerCalled).toBe(false);
    expect(ui.askUser).not.toHaveBeenCalled();
    const toolResultMessage = session.messages.find((m) => m.role === "tool");
    expect(toolResultMessage && "results" in toolResultMessage ? toolResultMessage.results[0]!.content : undefined).toContain("unavailable while in plan mode");
  });

  it("still allows a safe (read-only) tool while plan mode is on", async () => {
    let handlerCalled = false;
    const safeTool: ToolDefinition = {
      name: "read_file",
      description: "",
      riskLevel: "safe",
      inputSchema: { type: "object" },
      handler: async () => {
        handlerCalled = true;
        return { content: "file contents", isError: false };
      },
    };

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const tools = new ToolRegistry();
    tools.register(safeTool);
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.planMode = true;

    await runTurn(session, makeToolCallThenDoneProvider("read_file", {}), ui, tools, permissions, "look around");

    expect(handlerCalled).toBe(true);
  });

  it("exit_plan_mode goes through the normal permission flow and turns plan mode off on approval", async () => {
    const ui = makeStubUi();
    (ui.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("y");
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
    const tools = new ToolRegistry();
    const { exitPlanModeTool } = await import("../../src/tools/builtin/exit-plan-mode.js");
    tools.register(exitPlanModeTool);
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.planMode = true;

    await runTurn(session, makeToolCallThenDoneProvider("exit_plan_mode", { plan: "1. do X" }), ui, tools, permissions, "ready");

    expect(ui.askUser).toHaveBeenCalledTimes(1);
    expect(session.planMode).toBe(false);
  });

  it("exit_plan_mode leaves plan mode on when the user declines", async () => {
    const ui = makeStubUi();
    (ui.askUser as ReturnType<typeof vi.fn>).mockResolvedValue("n");
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
    const tools = new ToolRegistry();
    const { exitPlanModeTool } = await import("../../src/tools/builtin/exit-plan-mode.js");
    tools.register(exitPlanModeTool);
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    session.planMode = true;

    await runTurn(session, makeToolCallThenDoneProvider("exit_plan_mode", { plan: "1. do X" }), ui, tools, permissions, "ready");

    expect(session.planMode).toBe(true);
  });
});

describe("runTurn: checkpoints (for /rewind)", () => {
  it("records one checkpoint per user message, with the message index and edit-history size at that point", async () => {
    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    class EchoProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        return { assistantMessage: { role: "assistant", content: "ok" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
    }

    await runTurn(session, new EchoProvider(), ui, new ToolRegistry(), permissions, "first message");
    expect(session.checkpoints).toHaveLength(1);
    expect(session.checkpoints[0]).toMatchObject({ messageIndex: 1, historySize: 0, preview: "first message" });

    session.history.push({ path: "/tmp/a.txt", before: "old" });
    await runTurn(session, new EchoProvider(), ui, new ToolRegistry(), permissions, "second message");
    expect(session.checkpoints).toHaveLength(2);
    expect(session.checkpoints[1]).toMatchObject({ historySize: 1, preview: "second message" });
  });

  it("does not record a checkpoint when a UserPromptSubmit hook blocks the message", async () => {
    const ui = makeStubUi();
    const hooksConfig: HooksConfig = {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo '{\"decision\":\"block\",\"reason\":\"no\"}'" }] }],
    };
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });

    class ShouldNeverBeCalledProvider implements LlmProvider {
      async streamTurn(): Promise<StreamTurnResult> {
        throw new Error("must not be called");
      }
    }

    await runTurn(session, new ShouldNeverBeCalledProvider(), ui, new ToolRegistry(), permissions, "blocked message");
    expect(session.checkpoints).toHaveLength(0);
  });
});
