import { describe, expect, it, vi, beforeEach } from "vitest";

// Only sendToChat()'s queueing behavior is under test here — everything
// else resolveWebviewView wires up (config popups, session history, the
// permission/diff-view plumbing) is exercised elsewhere (message-handler.
// test.ts, vscode-ui-adapter.test.ts, diff-view.test.ts, session-runner.
// test.ts) or by the real-require smoke test in bundle.test.ts. The real
// engine modules (session-runner, vscode-ui-adapter, message-handler) are
// mocked so this test can drive resolveWebviewView's message flow directly
// without a real workspace/provider/tools.
// vi.mock factories are hoisted above these consts, so the mock fns
// themselves must be created inside vi.hoisted() — referencing a
// not-yet-initialized outer const directly from a hoisted factory throws
// "Cannot access before initialization".
const { executeCommand, showInformationMessage } = vi.hoisted(() => ({
  executeCommand: vi.fn().mockResolvedValue(undefined),
  showInformationMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("vscode", () => ({
  commands: { executeCommand },
  window: { showInformationMessage },
  workspace: { workspaceFolders: [{ uri: { fsPath: "/tmp/proj" } }] },
  Uri: { joinPath: (base: unknown, ...segs: string[]) => ({ toString: () => `${String(base)}/${segs.join("/")}` }) },
}));

const { createSessionRunnerMock } = vi.hoisted(() => ({ createSessionRunnerMock: vi.fn() }));
vi.mock("../../src/engine/session-runner.js", () => ({
  createSessionRunner: createSessionRunnerMock,
}));

const { createVscodeUiAdapterMock } = vi.hoisted(() => ({ createVscodeUiAdapterMock: vi.fn() }));
vi.mock("../../src/engine/vscode-ui-adapter.js", () => ({
  createVscodeUiAdapter: createVscodeUiAdapterMock,
}));

const { handleMock, createChatMessageHandlerMock } = vi.hoisted(() => {
  const handleMock = vi.fn().mockResolvedValue(undefined);
  return { handleMock, createChatMessageHandlerMock: vi.fn(() => handleMock) };
});
vi.mock("../../src/engine/message-handler.js", () => ({
  createChatMessageHandler: createChatMessageHandlerMock,
}));

import { ChatViewProvider } from "../../src/webview/chat-view-provider.js";

function makeWebviewView() {
  let listener: ((msg: unknown) => void) | undefined;
  const postMessage = vi.fn();
  const view = {
    webview: {
      options: undefined,
      html: "",
      postMessage,
      asWebviewUri: (uri: unknown) => uri,
      cspSource: "test-csp",
      onDidReceiveMessage: (cb: (msg: unknown) => void) => {
        listener = cb;
        return { dispose: vi.fn() };
      },
    },
    onDidDispose: vi.fn(),
    onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
    visible: true,
  };
  return { view, postMessage, trigger: (msg: unknown) => listener?.(msg) };
}

function makeContext() {
  return { subscriptions: [], workspaceState: { get: vi.fn(), update: vi.fn() } };
}

describe("ChatViewProvider.sendToChat", () => {
  beforeEach(() => {
    executeCommand.mockClear();
    showInformationMessage.mockClear();
    createSessionRunnerMock.mockReset().mockResolvedValue({ session: { id: "s1" }, sendMessage: vi.fn() });
    createVscodeUiAdapterMock.mockReset().mockReturnValue({ adapter: {}, resolvePending: vi.fn() });
    createChatMessageHandlerMock.mockClear();
    handleMock.mockReset().mockResolvedValue(undefined);
  });

  it("reveals the chat view via the auto-generated <viewId>.focus command", async () => {
    const provider = new ChatViewProvider({} as never, makeContext() as never);
    await provider.sendToChat("hello");
    expect(executeCommand).toHaveBeenCalledWith("finanfa.chatView.focus");
  });

  it("queues the insert when the webview hasn't finished its own webview_ready round-trip yet, then flushes it once it does", async () => {
    const provider = new ChatViewProvider({} as never, makeContext() as never);

    const sendPromise = provider.sendToChat("snippet text");
    const { view, postMessage, trigger } = makeWebviewView();
    provider.resolveWebviewView(view as never);
    await sendPromise;

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "insert_into_composer" }));

    trigger({ type: "webview_ready" });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "insert_into_composer", text: "snippet text" }));
  });

  it("delivers immediately, as a real user_message when autoSend, once the webview's handler is already ready", async () => {
    const provider = new ChatViewProvider({} as never, makeContext() as never);
    const { view, trigger } = makeWebviewView();
    provider.resolveWebviewView(view as never);
    trigger({ type: "webview_ready" });
    await vi.waitFor(() => expect(createChatMessageHandlerMock).toHaveBeenCalled());
    handleMock.mockClear();

    await provider.sendToChat("explain this", { autoSend: true });

    expect(handleMock).toHaveBeenCalledWith({ type: "user_message", text: "explain this" });
  });

  it("notifies and sets a badge on the view when a turn finishes while the panel isn't visible, and clears the badge once it's shown again", async () => {
    const provider = new ChatViewProvider({} as never, makeContext() as never);
    const { view, trigger } = makeWebviewView();
    (view as { visible: boolean }).visible = false;
    provider.resolveWebviewView(view as never);
    trigger({ type: "webview_ready" });
    await vi.waitFor(() => expect(createChatMessageHandlerMock).toHaveBeenCalled());

    const post = (createChatMessageHandlerMock.mock.calls[0] as unknown as unknown[])[2] as (msg: Record<string, unknown>) => void;
    post({ type: "assistant_end" });

    expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("new reply"), "Open");
    expect((view as { badge?: { value: number } }).badge).toEqual({ value: 1, tooltip: expect.any(String) });

    const visibilityCb = (view.onDidChangeVisibility as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as () => void;
    (view as { visible: boolean }).visible = true;
    visibilityCb();

    expect((view as { badge?: unknown }).badge).toBeUndefined();
  });

  it("does not notify when the panel is already visible — the reply is already on screen", async () => {
    const provider = new ChatViewProvider({} as never, makeContext() as never);
    const { view, trigger } = makeWebviewView();
    provider.resolveWebviewView(view as never);
    trigger({ type: "webview_ready" });
    await vi.waitFor(() => expect(createChatMessageHandlerMock).toHaveBeenCalled());

    const post = (createChatMessageHandlerMock.mock.calls[0] as unknown as unknown[])[2] as (msg: Record<string, unknown>) => void;
    post({ type: "assistant_end" });

    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it("delivers immediately as insert_into_composer (not a turn) when autoSend isn't requested", async () => {
    const provider = new ChatViewProvider({} as never, makeContext() as never);
    const { view, postMessage, trigger } = makeWebviewView();
    provider.resolveWebviewView(view as never);
    trigger({ type: "webview_ready" });
    await vi.waitFor(() => expect(createChatMessageHandlerMock).toHaveBeenCalled());
    postMessage.mockClear();
    handleMock.mockClear();

    await provider.sendToChat("add this");

    expect(postMessage).toHaveBeenCalledWith({ type: "insert_into_composer", text: "add this" });
    expect(handleMock).not.toHaveBeenCalledWith({ type: "user_message", text: "add this" });
  });
});
