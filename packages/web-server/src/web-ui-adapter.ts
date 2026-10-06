import type { WebSocket } from "ws";
import type { CommandInfo, StatusInfo, UIAdapter } from "@finanfa/core/src/ui/adapter.js";
import type { FilePreview } from "@finanfa/core/src/core/types.js";

/** Same ceiling the client applies before diffing: above it the diff isn't sent at all (the approval prompt still carries the tool's own text preview). */
export const MAX_FILE_PREVIEW_CHARS = 400_000;

/** What of a tool's before/after file preview goes over the wire: all of it, or nothing when it would be huge. */
export function filePreviewForClient(filePreview: FilePreview | undefined): FilePreview | undefined {
  if (!filePreview) return undefined;
  if (filePreview.before.length + filePreview.after.length > MAX_FILE_PREVIEW_CHARS) return undefined;
  return { path: filePreview.path, before: filePreview.before, after: filePreview.after };
}


/**
 * UIAdapter implementation for the web frontend: instead of writing to a
 * terminal, every call is serialized as a JSON event over the WebSocket
 * connection. askUser (permission prompts) resolves via a pending-request
 * map — the browser answers asynchronously with a "permission_response"
 * message carrying the same requestId, same round-trip shape the CLI's
 * readline/Ink adapters already use internally, just over the wire instead
 * of stdin.
 */
export function createWebUiAdapter(ws: WebSocket): { adapter: UIAdapter; resolvePending: (requestId: number, answer: string) => void } {
  const pending = new Map<number, (answer: string) => void>();
  let nextRequestId = 1;
  let currentStatus: StatusInfo | undefined;

  function send(type: string, payload: Record<string, unknown> = {}): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
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
      send("media", media);
    },
    writeTodos(todos) {
      send("todos", { todos });
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
      return new Promise<string>((resolve) => {
        const requestId = nextRequestId++;
        pending.set(requestId, resolve);
        send("ask", { requestId, prompt, kind, filePreview: filePreviewForClient(filePreview) });
      });
    },
    close() {
      // Connection lifecycle is owned by the WebSocket server, not the adapter.
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
