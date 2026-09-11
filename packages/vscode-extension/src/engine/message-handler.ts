import type { NeutralImage } from "@finanfa/core/src/core/types.js";
import type { SessionRunner } from "./session-runner.js";
import { buildHistoryReplay } from "./history.js";

export interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Routes messages arriving from the webview (webview_ready, user_message,
 * interrupt, permission_response, set_model, set_effort) to the real engine
 * — the VS Code-side mirror of packages/web-server/src/index.ts's own
 * ws.on("message") handling, minus the multi-connection concerns (no
 * per-connection message queue needed: a single webview panel talks to a
 * single SessionRunner, never two turns racing each other the way a
 * set_effort/user_message pair from the same browser tab could).
 *
 * Returned as a plain function (not a class bound to vscode.WebviewView) so
 * it's testable with a real SessionRunner and a fake `post` spy, no VS Code
 * process involved — see test/engine/message-handler.test.ts.
 */
export function createChatMessageHandler(
  runner: SessionRunner,
  resolvePending: (requestId: number, answer: string) => void,
  post: (msg: Record<string, unknown>) => void,
): (msg: WebviewMessage) => Promise<void> {
  let turnInFlight = false;

  function sendSessionInfo(): void {
    post({
      type: "session_info",
      id: runner.session.id,
      title: runner.session.title,
      model: runner.session.model,
      providerKind: runner.providerKind,
      toolCount: runner.tools.list().length,
      effort: runner.session.effort,
    });
  }

  return async function handleWebviewMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "webview_ready": {
        sendSessionInfo();
        post({ type: "history", messages: buildHistoryReplay(runner.session) });
        break;
      }
      case "user_message": {
        if (typeof msg.text !== "string") break;
        if (turnInFlight) {
          post({ type: "error", text: "A turn is already in progress — wait for it to finish (or interrupt) before sending another message." });
          break;
        }
        turnInFlight = true;
        try {
          await runner.sendMessage(msg.text, msg.images as NeutralImage[] | undefined);
        } catch (err) {
          post({ type: "error", text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` });
        } finally {
          turnInFlight = false;
        }
        break;
      }
      case "interrupt": {
        // Real reported regression this must not repeat (see git log:
        // "Fix Stop/interrupt being queued behind..."): interrupt has to
        // preempt an in-flight turn, never wait for one to finish first.
        // No queue exists yet in this handler (only user_message/interrupt
        // are wired so far, and this branch does nothing async), but
        // chat-view-provider.ts must call each incoming message
        // independently — never `await` them in one strict FIFO chain —
        // once set_model/set_effort are added later and a real ordering
        // concern reappears, so interrupt can't get stuck behind them either.
        for (const controller of runner.session.activeAbortControllers) controller.abort();
        break;
      }
      case "permission_response": {
        if (typeof msg.requestId === "number" && typeof msg.answer === "string") resolvePending(msg.requestId, msg.answer);
        break;
      }
      default:
        break;
    }
  };
}
