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
async function makeFakeRunner(sendMessage = vi.fn()): Promise<{ runner: SessionRunner; dir: string }> {
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
    dispose: vi.fn(),
  };
  return { runner, dir };
}

describe("createChatMessageHandler", () => {
  it("webview_ready posts session_info followed by the replayed history", async () => {
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
