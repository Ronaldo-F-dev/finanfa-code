import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import { ToolRegistry } from "@finanfa/core/src/tools/registry.js";
import { createChatMessageHandler } from "../../src/engine/message-handler.js";
import type { SessionRunner } from "../../src/engine/session-runner.js";

// Routing logic only — a real AgentSession (cheap, no network) stands in for
// a full SessionRunner via a stub sendMessage, so these tests focus purely
// on "does each incoming message type get routed correctly" without needing
// a real provider/fake HTTP server (that end-to-end path is already covered
// by session-runner.test.ts).
async function makeFakeRunner(
  sendMessage = vi.fn(),
  overrides: Partial<SessionRunner> = {},
): Promise<{ runner: SessionRunner; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "finanfa-message-handler-"));
  const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
  const runner: SessionRunner = {
    session,
    provider: undefined as never,
    tools: new ToolRegistry(),
    permissions: undefined as never,
    mcp: undefined as never,
    browser: undefined as never,
    commands: undefined as never,
    providerKind: "openai-compatible",
    sendMessage,
    listModels: vi.fn().mockResolvedValue({ activeProviderKind: "openai-compatible", defaultModel: "m", models: [] }),
    listEffortTiers: vi.fn().mockResolvedValue([]),
    switchModel: vi.fn().mockResolvedValue({ ok: true }),
    setEffort: vi.fn().mockResolvedValue({ ok: true }),
    pullOllamaModel: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    ...overrides,
  };
  return { runner, dir };
}

describe("createChatMessageHandler", () => {
  it("webview_ready posts session_info followed by the replayed history, then model_list/effort_tiers", async () => {
    const { runner, dir } = await makeFakeRunner();
    try {
      runner.session.messages = [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }];
      const post = vi.fn();
      const handle = createChatMessageHandler(runner, vi.fn(), post);

      await handle({ type: "webview_ready" });

      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session_info", id: runner.session.id, model: "m", providerKind: "openai-compatible" }),
      );
      expect(post).toHaveBeenCalledWith({
        type: "history",
        messages: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "reply" },
        ],
      });
      expect(runner.listModels).toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "model_list", models: [] }));
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "effort_tiers", tiers: [] }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("user_message calls sendMessage with the text and images", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { runner, dir } = await makeFakeRunner(sendMessage);
    try {
      const handle = createChatMessageHandler(runner, vi.fn(), vi.fn());
      const images = [{ mimeType: "image/png", base64: "abc" }];

      await handle({ type: "user_message", text: "hello", images });

      expect(sendMessage).toHaveBeenCalledWith("hello", images);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a second user_message while one is still in flight", async () => {
    let resolveFirst!: () => void;
    const sendMessage = vi.fn().mockImplementation(() => new Promise<void>((resolve) => (resolveFirst = resolve)));
    const { runner, dir } = await makeFakeRunner(sendMessage);
    try {
      const post = vi.fn();
      const handle = createChatMessageHandler(runner, vi.fn(), post);

      const firstCall = handle({ type: "user_message", text: "one" });
      await handle({ type: "user_message", text: "two" });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "error", text: expect.stringContaining("already in progress") }));

      resolveFirst();
      await firstCall;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a sendMessage that throws is reported as an error, not left to reject the handler", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("boom"));
    const { runner, dir } = await makeFakeRunner(sendMessage);
    try {
      const post = vi.fn();
      const handle = createChatMessageHandler(runner, vi.fn(), post);

      await expect(handle({ type: "user_message", text: "x" })).resolves.toBeUndefined();
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "error", text: expect.stringContaining("boom") }));

      // The in-flight guard must clear even after a failure — otherwise
      // every later message would wrongly be told a turn is still running.
      await handle({ type: "user_message", text: "y" });
      expect(sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("interrupt aborts every active controller on the session", async () => {
    const { runner, dir } = await makeFakeRunner();
    try {
      const controller = new AbortController();
      runner.session.activeAbortControllers.add(controller);
      const handle = createChatMessageHandler(runner, vi.fn(), vi.fn());

      await handle({ type: "interrupt" });

      expect(controller.signal.aborted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("permission_response forwards requestId/answer to resolvePending", async () => {
    const { runner, dir } = await makeFakeRunner();
    try {
      const resolvePending = vi.fn();
      const handle = createChatMessageHandler(runner, resolvePending, vi.fn());

      await handle({ type: "permission_response", requestId: 3, answer: "y" });

      expect(resolvePending).toHaveBeenCalledWith(3, "y");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("set_model calls switchModel and posts session_info on success", async () => {
    const { runner, dir } = await makeFakeRunner();
    try {
      const post = vi.fn();
      const handle = createChatMessageHandler(runner, vi.fn(), post);

      await handle({ type: "set_model", model: "claude-sonnet-5", family: "anthropic" });

      expect(runner.switchModel).toHaveBeenCalledWith("claude-sonnet-5", "anthropic", undefined);
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "session_info" }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("set_model posts model_unavailable instead of session_info when switchModel refuses", async () => {
    const { runner, dir } = await makeFakeRunner(vi.fn(), {
      switchModel: vi.fn().mockResolvedValue({ ok: false, kind: "model_unavailable", model: "claude-opus-5", family: "anthropic", message: "no key" }),
    });
    try {
      const post = vi.fn();
      const handle = createChatMessageHandler(runner, vi.fn(), post);

      await handle({ type: "set_model", model: "claude-opus-5", family: "anthropic" });

      expect(post).toHaveBeenCalledWith({ type: "model_unavailable", model: "claude-opus-5", family: "anthropic", message: "no key" });
      expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session_info" }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("set_model is rejected with an error while a turn is in flight, same as user_message", async () => {
    let resolveFirst!: () => void;
    const sendMessage = vi.fn().mockImplementation(() => new Promise<void>((resolve) => (resolveFirst = resolve)));
    const { runner, dir } = await makeFakeRunner(sendMessage);
    try {
      const post = vi.fn();
      const handle = createChatMessageHandler(runner, vi.fn(), post);

      const firstCall = handle({ type: "user_message", text: "one" });
      await handle({ type: "set_model", model: "claude-sonnet-5", family: "anthropic" });

      expect(runner.switchModel).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "error", text: expect.stringContaining("in progress") }));

      resolveFirst();
      await firstCall;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("set_effort calls setEffort and posts session_info on success", async () => {
    const { runner, dir } = await makeFakeRunner();
    try {
      const post = vi.fn();
      const handle = createChatMessageHandler(runner, vi.fn(), post);

      await handle({ type: "set_effort", level: "medium" });

      expect(runner.setEffort).toHaveBeenCalledWith("medium");
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "session_info" }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("set_effort posts effort_needs_download when the tier's model isn't installed", async () => {
    const { runner, dir } = await makeFakeRunner(vi.fn(), {
      setEffort: vi.fn().mockResolvedValue({ ok: false, kind: "effort_needs_download", level: "medium", ollamaModel: "qwen3:4b-instruct" }),
    });
    try {
      const post = vi.fn();
      const handle = createChatMessageHandler(runner, vi.fn(), post);

      await handle({ type: "set_effort", level: "medium" });

      expect(post).toHaveBeenCalledWith({ type: "effort_needs_download", level: "medium", ollamaModel: "qwen3:4b-instruct" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pull_ollama_model streams progress then done", async () => {
    const pullOllamaModel = vi.fn().mockImplementation(async (_name: string, onProgress: (c?: number, t?: number) => void) => {
      onProgress(50, 100);
    });
    const { runner, dir } = await makeFakeRunner(vi.fn(), { pullOllamaModel });
    try {
      const post = vi.fn();
      const handle = createChatMessageHandler(runner, vi.fn(), post);

      await handle({ type: "pull_ollama_model", name: "qwen3:4b-instruct" });

      expect(post).toHaveBeenCalledWith({ type: "ollama_pull_progress", name: "qwen3:4b-instruct", completed: 50, total: 100 });
      expect(post).toHaveBeenCalledWith({ type: "ollama_pull_done", name: "qwen3:4b-instruct" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pull_ollama_model posts ollama_pull_error when the pull rejects", async () => {
    const { runner, dir } = await makeFakeRunner(vi.fn(), { pullOllamaModel: vi.fn().mockRejectedValue(new Error("network down")) });
    try {
      const post = vi.fn();
      const handle = createChatMessageHandler(runner, vi.fn(), post);

      await handle({ type: "pull_ollama_model", name: "qwen3:4b-instruct" });

      expect(post).toHaveBeenCalledWith({ type: "ollama_pull_error", name: "qwen3:4b-instruct", message: "network down" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an unknown message type is ignored, not thrown", async () => {
    const { runner, dir } = await makeFakeRunner();
    try {
      const handle = createChatMessageHandler(runner, vi.fn(), vi.fn());
      await expect(handle({ type: "something_unexpected" })).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
