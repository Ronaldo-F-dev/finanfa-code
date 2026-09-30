import type { NeutralImage } from "@finanfa/core/src/core/types.js";
import type { SessionRunner } from "./session-runner.js";
import { buildHistoryReplay } from "./history.js";
import { runCompactCommand } from "@finanfa/core/src/core/loop.js";

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
  // A plain mutable holder (not a bare closure variable) so each of the
  // per-case handlers below — split out of what used to be one large
  // switch, for a real reason: that single function's combined branching
  // across 8 message types was flagged as excessive Cognitive Complexity —
  // can read and set the same shared in-flight guard.
  const state = { turnInFlight: false };

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

  async function handleWebviewReady(): Promise<void> {
    sendSessionInfo();
    post({ type: "history", messages: buildHistoryReplay(runner.session) });
    // Replaces web-client's fetch("/api/models")/fetch("/api/effort-tiers")
    // — no HTTP API in the extension, so both are pushed once up front
    // instead (see the plan's §1 on model_list being new vocabulary).
    const [models, tiers] = await Promise.all([runner.listModels(), runner.listEffortTiers()]);
    post({ type: "model_list", models: models.models });
    post({ type: "effort_tiers", tiers });
  }

  async function handleUserMessage(msg: WebviewMessage): Promise<void> {
    if (typeof msg.text !== "string") return;
    if (state.turnInFlight) {
      post({ type: "error", text: "A turn is already in progress — wait for it to finish (or interrupt) before sending another message." });
      return;
    }
    state.turnInFlight = true;
    try {
      await runner.sendMessage(msg.text, msg.images as NeutralImage[] | undefined);
    } catch (err) {
      post({ type: "error", text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      state.turnInFlight = false;
    }
  }

  async function handleSetModel(msg: WebviewMessage): Promise<void> {
    if (typeof msg.model !== "string" || !msg.model || typeof msg.family !== "string") return;
    // Same guard as user_message, extended to cover set_model/set_effort:
    // both do real awaited work (probing Ollama, rebuilding a provider)
    // before touching session.model/providerKind — a user_message racing in
    // during that window would otherwise capture a stale provider for its
    // turn, the exact bug fixed on the web side (see web-server's own
    // comment on this same race).
    if (state.turnInFlight) {
      post({ type: "error", text: "A turn is already in progress — wait for it to finish before switching models." });
      return;
    }
    state.turnInFlight = true;
    try {
      const result = await runner.switchModel(msg.model as string, msg.family as string, typeof msg.baseUrl === "string" ? msg.baseUrl : undefined);
      if (result.ok) sendSessionInfo();
      else post({ type: "model_unavailable", model: result.model, family: result.family, message: result.message });
    } finally {
      state.turnInFlight = false;
    }
  }

  async function handleSetEffort(msg: WebviewMessage): Promise<void> {
    if (typeof msg.level !== "string") return;
    if (state.turnInFlight) {
      post({ type: "error", text: "A turn is already in progress — wait for it to finish before changing effort." });
      return;
    }
    state.turnInFlight = true;
    try {
      const result = await runner.setEffort(msg.level);
      if (result.ok) sendSessionInfo();
      else if (result.kind === "effort_needs_download") post({ type: "effort_needs_download", level: result.level, ollamaModel: result.ollamaModel });
      else if (result.kind === "model_unavailable") post({ type: "model_unavailable", model: result.model, family: result.family, message: result.message });
      else post({ type: "error", text: result.message });
    } finally {
      state.turnInFlight = false;
    }
  }

  async function handlePullOllamaModel(msg: WebviewMessage): Promise<void> {
    if (typeof msg.name !== "string" || !msg.name) return;
    const name = msg.name;
    try {
      await runner.pullOllamaModel(name, (completed, total) => post({ type: "ollama_pull_progress", name, completed, total }));
      post({ type: "ollama_pull_done", name });
    } catch (err) {
      post({ type: "ollama_pull_error", name, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleCompact(): Promise<void> {
    // Same turnInFlight guard user_message uses (compactSession replaces
    // session.messages wholesale, so a user_message racing in
    // mid-compaction would corrupt it), held for the whole call, not just
    // checked at the start. The actual busy/system-message/compaction
    // sequence itself lives in runCompactCommand (loop.ts), shared with
    // web-server's own "compact" branch — this used to be duplicated
    // near-verbatim between the two.
    if (state.turnInFlight) {
      post({ type: "error", text: "A turn is already in progress — wait for it to finish (or interrupt) before compacting." });
      return;
    }
    state.turnInFlight = true;
    try {
      const result = await runCompactCommand(runner.session, runner.provider, {
        setBusy: (busy, label) => post({ type: "busy", busy, label }),
        writeSystem: (text) => post({ type: "system", text }),
      });
      // The webview's timeline holds the old turns individually — tell it
      // to replace them with just the two-message summary now actually in
      // session.messages, same replace:true path a resumed session's
      // initial "history" reply already uses.
      if (result.replacedMessages) post({ type: "history", replace: true, messages: result.replacedMessages });
    } finally {
      state.turnInFlight = false;
    }
  }

  function handleInterrupt(): void {
    // Real reported regression this must not repeat (see git log: "Fix
    // Stop/interrupt being queued behind..."): interrupt has to preempt an
    // in-flight turn, never wait for one to finish first. No queue exists
    // yet in this handler (only user_message/interrupt are wired so far,
    // and this branch does nothing async), but chat-view-provider.ts must
    // call each incoming message independently — never `await` them in one
    // strict FIFO chain — once set_model/set_effort are added later and a
    // real ordering concern reappears, so interrupt can't get stuck behind
    // them either.
    for (const controller of runner.session.activeAbortControllers) controller.abort();
  }

  function handlePermissionResponse(msg: WebviewMessage): void {
    if (typeof msg.requestId === "number" && typeof msg.answer === "string") resolvePending(msg.requestId, msg.answer);
  }

  return async function handleWebviewMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "webview_ready":
        return handleWebviewReady();
      case "user_message":
        return handleUserMessage(msg);
      case "set_model":
        return handleSetModel(msg);
      case "set_effort":
        return handleSetEffort(msg);
      case "pull_ollama_model":
        return handlePullOllamaModel(msg);
      case "compact":
        return handleCompact();
      case "interrupt":
        return handleInterrupt();
      case "permission_response":
        return handlePermissionResponse(msg);
      default:
        return;
    }
  };
}
