import type { WebSocket } from "ws";
import type { CommandInfo, StatusInfo, UIAdapter } from "@finanfa/core/src/ui/adapter.js";

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
    writeError(text) {
      send("error", { text });
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
    askUser(prompt, kind = "input") {
      return new Promise<string>((resolve) => {
        const requestId = nextRequestId++;
        pending.set(requestId, resolve);
        send("ask", { requestId, prompt, kind });
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
