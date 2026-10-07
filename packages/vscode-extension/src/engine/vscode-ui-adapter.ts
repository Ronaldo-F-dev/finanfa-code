import type { CommandInfo, StatusInfo, UIAdapter } from "@finanfa/core/src/ui/adapter.js";
import type { FilePreview } from "@finanfa/core/src/core/types.js";

/**
 * UIAdapter implementation for the VS Code webview — same shape as
 * packages/web-server/src/web-ui-adapter.ts (every call serialized as a
 * `{type, ...payload}` message, askUser resolved via a pending-request map
 * answered later by a "permission_response" message), just parameterized
 * over a plain `post` callback instead of a `ws` object — the caller
 * (chat-view-provider.ts) supplies `(msg) => webviewView.webview.postMessage(msg)`.
 * Keeping this decoupled from the real `vscode` module's types means it's
 * directly unit-testable with a bare function, no VS Code process needed.
 */
export function createVscodeUiAdapter(
  post: (msg: Record<string, unknown>) => void,
  /**
   * Resolves a local filesystem path (a generated audio/image file) to a
   * webview-safe URI via `webview.asWebviewUri(vscode.Uri.file(path))` —
   * supplied by chat-view-provider.ts, which is the only place holding a
   * real `vscode.Webview` object. There is no HTTP server here to serve
   * `/api/workspace-file` the way web-server does, so ChatMessage.tsx reads
   * this pre-resolved URI instead (falling back to the bare path if unset,
   * e.g. in a unit test with no real webview).
   */
  resolveMediaUri?: (path: string) => string | undefined,
  /**
   * Opens a real native VS Code diff editor tab for a file-editing tool's
   * permission prompt (write_file/edit_file/multi_edit_file — see
   * ToolDefinition.filePreview) — supplied by chat-view-provider.ts, the
   * only place holding a real `vscode` module import. Fire-and-forget: the
   * permission decision itself is still made through the normal ask/
   * permission_response round trip (the PermissionModal in the webview),
   * this is purely an additional, richer view alongside it. A unit test
   * with no real VS Code window simply omits this and gets the exact same
   * askUser behavior as before this parameter existed.
   */
  openFileDiff?: (preview: FilePreview) => void,
): {
  adapter: UIAdapter;
  resolvePending: (requestId: number, answer: string) => void;
} {
  const pending = new Map<number, (answer: string) => void>();
  let nextRequestId = 1;
  let currentStatus: StatusInfo | undefined;

  function send(type: string, payload: Record<string, unknown> = {}): void {
    post({ type, ...payload });
  }

  const adapter: UIAdapter = {
    writeAssistantDelta(text) {
      send("assistant_delta", { text });
    },
    endAssistantMessage() {
      send("assistant_end");
    },
    writeBanner(version) {
      send("banner", { version });
    },
    writeSystem(text) {
      send("system", { text });
    },
    writeToolCall(info) {
      send("tool_call", { ...info });
    },
    writeToolResult(info) {
      send("tool_result", { ...info });
    },
    writeThinkingDelta(text) {
      send("thinking_delta", { text });
    },
    writeError(text) {
      send("error", { text });
    },
    writeMedia(media) {
      send("media", { ...media, webviewUri: resolveMediaUri?.(media.path) });
    },
    setStatus(status) {
      currentStatus = status;
      send("status", { status });
    },
    getStatus() {
      return currentStatus;
    },
    setCommands(commands: CommandInfo[]) {
      send("commands", { commands });
    },
    setBusy(busy, label) {
      send("busy", { busy, label });
    },
    askUser(prompt, kind = "input", _toolCallId, filePreview) {
      if (filePreview) openFileDiff?.(filePreview);
      return new Promise<string>((resolve) => {
        const requestId = nextRequestId++;
        pending.set(requestId, resolve);
        send("ask", { requestId, prompt, kind });
      });
    },
    close() {
      // Panel lifecycle is owned by chat-view-provider.ts, not the adapter.
    },
  };

  function resolvePending(requestId: number, answer: string): void {
    const resolve = pending.get(requestId);
    if (!resolve) return;
    pending.delete(requestId);
    resolve(answer);
  }

  return { adapter, resolvePending };
}
