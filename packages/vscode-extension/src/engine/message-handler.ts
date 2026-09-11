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
        // Replaces web-client's fetch("/api/models")/fetch("/api/effort-tiers")
        // — no HTTP API in the extension, so both are pushed once up front
        // instead (see the plan's §1 on model_list being new vocabulary).
        const [models, tiers] = await Promise.all([runner.listModels(), runner.listEffortTiers()]);
        post({ type: "model_list", models: models.models });
        post({ type: "effort_tiers", tiers });
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
      case "set_model": {
        if (typeof msg.model !== "string" || !msg.model || typeof msg.family !== "string") break;
        // Same guard as user_message, extended to cover set_model/set_effort:
        // both do real awaited work (probing Ollama, rebuilding a provider)
        // before touching session.model/providerKind — a user_message
        // racing in during that window would otherwise capture a stale
        // provider for its turn, the exact bug fixed on the web side (see
        // web-server's own comment on this same race).
        if (turnInFlight) {
          post({ type: "error", text: "A turn is already in progress — wait for it to finish before switching models." });
          break;
        }
        turnInFlight = true;
        try {
          const result = await runner.switchModel(msg.model, msg.family, typeof msg.baseUrl === "string" ? msg.baseUrl : undefined);
          if (result.ok) sendSessionInfo();
          else post({ type: "model_unavailable", model: result.model, family: result.family, message: result.message });
        } finally {
          turnInFlight = false;
        }
        break;
      }
      case "set_effort": {
        if (typeof msg.level !== "string") break;
        if (turnInFlight) {
          post({ type: "error", text: "A turn is already in progress — wait for it to finish before changing effort." });
          break;
        }
        turnInFlight = true;
        try {
          const result = await runner.setEffort(msg.level);
          if (result.ok) sendSessionInfo();
          else if (result.kind === "effort_needs_download") post({ type: "effort_needs_download", level: result.level, ollamaModel: result.ollamaModel });
          else if (result.kind === "model_unavailable") post({ type: "model_unavailable", model: result.model, family: result.family, message: result.message });
          else post({ type: "error", text: result.message });
        } finally {
          turnInFlight = false;
        }
        break;
      }
      case "pull_ollama_model": {
        if (typeof msg.name !== "string" || !msg.name) break;
        const name = msg.name;
        try {
          await runner.pullOllamaModel(name, (completed, total) => post({ type: "ollama_pull_progress", name, completed, total }));
          post({ type: "ollama_pull_done", name });
        } catch (err) {
          post({ type: "ollama_pull_error", name, message: err instanceof Error ? err.message : String(err) });
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
