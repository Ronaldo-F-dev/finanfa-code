import { describe, expect, it, vi } from "vitest";
import { createVscodeUiAdapter } from "../../src/engine/vscode-ui-adapter.js";

describe("createVscodeUiAdapter", () => {
  it("serializes every UIAdapter call as a {type, ...payload} message via the given post callback", () => {
    const post = vi.fn();
    const { adapter } = createVscodeUiAdapter(post);

    adapter.writeAssistantDelta("hello");
    adapter.endAssistantMessage();
    adapter.writeBanner("1.0.0");
    adapter.writeSystem("sys");
    adapter.writeError("err");
    adapter.writeToolCall?.({ toolName: "bash", description: "ls", riskLevel: "dangerous" });
    adapter.writeMedia?.({ kind: "image", path: "/tmp/x.png", mimeType: "image/png" });
    adapter.setStatus({ tokens: 10, costUsd: 0.01, model: "m" });
    adapter.setCommands([{ name: "cost", description: "show cost" }]);
    adapter.setBusy(true, "thinking");

    expect(post).toHaveBeenCalledWith({ type: "assistant_delta", text: "hello" });
    expect(post).toHaveBeenCalledWith({ type: "assistant_end" });
    expect(post).toHaveBeenCalledWith({ type: "banner", version: "1.0.0" });
    expect(post).toHaveBeenCalledWith({ type: "system", text: "sys" });
    expect(post).toHaveBeenCalledWith({ type: "error", text: "err" });
    expect(post).toHaveBeenCalledWith({ type: "tool_call", toolName: "bash", description: "ls", riskLevel: "dangerous" });
    expect(post).toHaveBeenCalledWith({ type: "media", kind: "image", path: "/tmp/x.png", mimeType: "image/png" });
    expect(post).toHaveBeenCalledWith({ type: "status", status: { tokens: 10, costUsd: 0.01, model: "m" } });
    expect(post).toHaveBeenCalledWith({ type: "commands", commands: [{ name: "cost", description: "show cost" }] });
    expect(post).toHaveBeenCalledWith({ type: "busy", busy: true, label: "thinking" });
  });

  it("getStatus() returns the last status set, without re-posting", () => {
    const post = vi.fn();
    const { adapter } = createVscodeUiAdapter(post);
    expect(adapter.getStatus()).toBeUndefined();
    adapter.setStatus({ tokens: 1, costUsd: 0, model: "m" });
    post.mockClear();
    expect(adapter.getStatus()).toEqual({ tokens: 1, costUsd: 0, model: "m" });
    expect(post).not.toHaveBeenCalled();
  });

  it("askUser posts an ask message and resolves once resolvePending answers the matching requestId", async () => {
    const post = vi.fn();
    const { adapter, resolvePending } = createVscodeUiAdapter(post);

    const promise = adapter.askUser("Allow this?", "confirm");
    expect(post).toHaveBeenCalledWith({ type: "ask", requestId: 1, prompt: "Allow this?", kind: "confirm" });

    resolvePending(1, "y");
    await expect(promise).resolves.toBe("y");
  });

  it("resolvePending for an unknown/already-answered requestId is a harmless no-op", () => {
    const post = vi.fn();
    const { resolvePending } = createVscodeUiAdapter(post);
    expect(() => resolvePending(999, "y")).not.toThrow();
  });

  it("two concurrent askUser calls get distinct requestIds and resolve independently", async () => {
    const post = vi.fn();
    const { adapter, resolvePending } = createVscodeUiAdapter(post);

    const first = adapter.askUser("first?");
    const second = adapter.askUser("second?");
    resolvePending(2, "second-answer");
    resolvePending(1, "first-answer");

    await expect(first).resolves.toBe("first-answer");
    await expect(second).resolves.toBe("second-answer");
  });
});
