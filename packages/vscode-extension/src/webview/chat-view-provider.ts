import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { globalConfigPath, saveGlobalConfig, type FinanfaConfig } from "@finanfa/core/src/core/config.js";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import { createSessionRunner, type SessionRunner } from "../engine/session-runner.js";
import { createVscodeUiAdapter } from "../engine/vscode-ui-adapter.js";
import { createChatMessageHandler, type WebviewMessage } from "../engine/message-handler.js";
import { getNonce } from "./nonce.js";

const LAST_SESSION_KEY = "finanfa.lastSessionId";

/** Only the global file (~/.finanfa-code/config.json) — loadConfig() merges in the project one too, which we must not accidentally duplicate into the global file. */
async function readGlobalConfig(): Promise<FinanfaConfig> {
  try {
    return JSON.parse(await readFile(globalConfigPath(), "utf-8")) as FinanfaConfig;
  } catch {
    return {};
  }
}

/**
 * HTML shell for the real React app — replaces html.ts's earlier
 * dependency-free inline-script placeholder (steps 3+4 of the plan) now
 * that the full webview-ui bundle exists. Every resource is loaded through
 * `webview.asWebviewUri` (a bare file:// path fails silently under CSP,
 * visible only in the webview's own devtools) and the single <script> tag
 * carries the nonce, per the CSP below.
 */
function renderChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", "index.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", "index.css"));
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; media-src ${webview.cspSource} data:;" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>finanfa-code</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private runner?: SessionRunner;
  // Held so createHandler() (called asynchronously via ensureReady) can
  // resolve a local media path to a webview-safe URI — only this object
  // exposes asWebviewUri, and resolveWebviewView's own local `webviewView`
  // parameter isn't otherwise reachable from that later call.
  private webviewView?: vscode.WebviewView;
  // Single-flight: without this, two messages arriving before the first
  // await inside ensureReady() resolves would each start their own
  // createSessionRunner() call, racing to create two AgentSessions on the
  // same project. webview_ready is the only message sent on mount today,
  // but this guards it for when the full composer (step 5+) can fire a
  // user_message right after.
  private handlerPromise?: Promise<(msg: WebviewMessage) => Promise<void>>;
  // Guards against two workspace-id popups stacking if more than one error
  // message matches in quick succession (e.g. a retried turn failing the
  // same way before the first popup is dismissed).
  private workspaceIdPromptInFlight = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = renderChatHtml(webviewView.webview, this.extensionUri);

    const post = (msg: Record<string, unknown>): void => {
      // Real reported error: an org-admin-scoped Anthropic API key (as
      // opposed to one already scoped to a single workspace) is rejected
      // with this exact 400 unless every request carries an
      // anthropic-workspace-id header (see AnthropicProvider's constructor
      // comment) — caught here, at the one place every runTurn error
      // already flows through, rather than teaching the provider itself
      // about VS Code popups.
      if (msg.type === "error" && typeof msg.text === "string" && msg.text.includes("anthropic-workspace-id")) {
        void this.promptForWorkspaceId(post);
      }
      void webviewView.webview.postMessage(msg);
    };

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      // needs_api_key intercepted here, not routed to message-handler.ts:
      // it's a native VS Code input box + writing ~/.finanfa-code/config.json
      // directly, not engine wiring — there's no Settings modal in this
      // phase (out of scope), so picking a model that needs a key used to
      // just silently do nothing, then only show a banner explaining how to
      // edit the file by hand. Every model this catalog can ever mark
      // unconfigured is "anthropic" family (see session-runner.ts's
      // listModels — openai-compatible/local entries are always
      // configured:true), so a single Anthropic key is always the right ask.
      if (msg.type === "needs_api_key") {
        const modelName = typeof msg.model === "string" ? msg.model : undefined;
        void this.handleNeedsApiKey(post, modelName);
        return;
      }
      if (msg.type === "new_chat") {
        void this.startNewChat(post);
        return;
      }
      if (msg.type === "list_sessions") {
        void this.postSessionList(post);
        return;
      }
      if (msg.type === "switch_session" && typeof msg.id === "string") {
        void this.switchToSession(post, msg.id);
        return;
      }
      if (msg.type === "delete_session" && typeof msg.id === "string") {
        void this.deleteSession(post, msg.id);
        return;
      }
      // Deliberately not awaited/chained in strict FIFO order here — see
      // message-handler.ts's own comment on the "interrupt" branch for why
      // that matters once more message types are wired in.
      void this.ensureReady(post).then((handle) => handle(msg));
    });

    webviewView.onDidDispose(() => {
      void this.runner?.dispose();
      this.runner = undefined;
      this.handlerPromise = undefined;
      this.webviewView = undefined;
    });
  }

  private ensureReady(post: (msg: Record<string, unknown>) => void): Promise<(msg: WebviewMessage) => Promise<void>> {
    if (!this.handlerPromise) this.handlerPromise = this.createHandler(post);
    return this.handlerPromise;
  }

  /**
   * "Nouvelle conversation" — no multi-session sidebar in this phase (out
   * of scope), just a way to stop reusing the workspace's one remembered
   * session going forward. Disposes the current runner (persists it one
   * last time) and rebuilds a fresh one with forceNew, then clears the
   * webview's timeline explicitly (its own webview_ready/history reply
   * would otherwise just prepend an empty array onto the old messages
   * still sitting in React state).
   */
  private async startNewChat(post: (msg: Record<string, unknown>) => void): Promise<void> {
    await this.runner?.dispose();
    this.runner = undefined;
    post({ type: "history", messages: [], replace: true });
    this.handlerPromise = this.createHandler(post, { forceNew: true });
    const handle = await this.handlerPromise;
    await handle({ type: "webview_ready" });
  }

  /** No sidebar in this phase — a flat, on-demand list is the minimal way to see and reopen past conversations for this workspace. */
  private async postSessionList(post: (msg: Record<string, unknown>) => void): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const sessions = folder ? await AgentSession.list(folder.uri.fsPath) : [];
    post({ type: "sessions", sessions: sessions.map((s) => ({ id: s.id, mtime: s.mtime.toISOString(), title: s.title })) });
  }

  private async switchToSession(post: (msg: Record<string, unknown>) => void, id: string): Promise<void> {
    await this.runner?.dispose();
    this.runner = undefined;
    post({ type: "history", messages: [], replace: true });
    this.handlerPromise = this.createHandler(post, { resumeSessionId: id });
    const handle = await this.handlerPromise;
    await handle({ type: "webview_ready" });
  }

  private async deleteSession(post: (msg: Record<string, unknown>) => void, id: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const wasActive = this.runner?.session.id === id;
    await AgentSession.delete(folder.uri.fsPath, id);
    if (wasActive) await this.startNewChat(post);
    await this.postSessionList(post);
  }

  /**
   * Real popup (not just a banner explaining where to edit a file by hand):
   * asks for the key, saves it to ~/.finanfa-code/config.json, then starts a
   * fresh chat so the new SessionRunner reloads config from disk (the
   * running one already captured its own config snapshot at creation time —
   * see session-runner.ts's `config` closure — so it would never notice a
   * key written after the fact) and immediately switches it to the model
   * the user originally picked, so "paste the key" is the only step left to
   * the user; everything after that is automatic.
   */
  private async handleNeedsApiKey(post: (msg: Record<string, unknown>) => void, modelId?: string): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: modelId ? `Clé API Anthropic pour "${modelId}"` : "Clé API Anthropic",
      prompt: "Collez votre clé API Anthropic (sk-ant-...) — elle sera enregistrée dans ~/.finanfa-code/config.json",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "sk-ant-...",
    });
    if (!key) return; // cancelled — leave everything as it was, no banner needed

    const current = await readGlobalConfig();
    await saveGlobalConfig({ ...current, anthropicApiKey: key });
    void vscode.window.showInformationMessage(`Clé enregistrée. Démarrage d'une nouvelle conversation avec "${modelId}"...`);

    await this.startNewChat(post);
    if (modelId) {
      const handle = await this.handlerPromise;
      await handle?.({ type: "set_model", model: modelId, family: "anthropic" });
    }
  }

  /**
   * Fires when a turn's error text names the specific 400 an org-admin-
   * scoped Anthropic key gets rejected with (see the `post` wrapper above
   * and AnthropicProvider's constructor comment) — same "real popup, agent
   * saves the rest" pattern as handleNeedsApiKey, just triggered by a live
   * failure instead of picking an unconfigured model.
   */
  private async promptForWorkspaceId(post: (msg: Record<string, unknown>) => void): Promise<void> {
    if (this.workspaceIdPromptInFlight) return;
    this.workspaceIdPromptInFlight = true;
    try {
      const workspaceId = await vscode.window.showInputBox({
        title: "ID de workspace Anthropic requis",
        prompt:
          "Cette clé API Anthropic est liée à l'organisation entière, pas à un workspace précis. " +
          "Collez l'ID du workspace à utiliser (console.anthropic.com → Settings → Workspaces).",
        ignoreFocusOut: true,
        placeHolder: "wrkspc_...",
      });
      if (!workspaceId) return;

      const current = await readGlobalConfig();
      await saveGlobalConfig({ ...current, anthropicWorkspaceId: workspaceId });
      void vscode.window.showInformationMessage("ID de workspace enregistré. Renvoyez votre message.");
      await this.startNewChat(post);
    } finally {
      this.workspaceIdPromptInFlight = false;
    }
  }

  private async createHandler(
    post: (msg: Record<string, unknown>) => void,
    opts: { forceNew?: boolean; resumeSessionId?: string } = {},
  ): Promise<(msg: WebviewMessage) => Promise<void>> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      // No engine to start — every incoming message just gets the same
      // clear explanation instead of a session silently failing to exist.
      return async () => post({ type: "error", text: "Open a folder to start a finanfa-code session." });
    }

    const { adapter, resolvePending } = createVscodeUiAdapter(post, (path) =>
      this.webviewView?.webview.asWebviewUri(vscode.Uri.file(path)).toString(),
    );
    // Reprise automatique de la dernière session de ce workspace (voir le
    // plan, §2) — pas de commande à taper, contrairement au --resume/
    // --continue du CLI. Skipped for a deliberate "new chat"; overridden by
    // an explicit id when switching to a specific past session (history).
    const resumeSessionId = opts.resumeSessionId ?? (opts.forceNew ? undefined : this.context.workspaceState.get<string>(LAST_SESSION_KEY));
    this.runner = await createSessionRunner(folder.uri.fsPath, adapter, { resumeSessionId });
    // Deliberately NOT recorded here for a brand-new session (resumeSessionId
    // missing, or resume failed): AgentSession.persist() only happens during
    // a real turn (see loop.ts), so a session closed before its first
    // message never reaches disk — recording its id immediately would leave
    // workspaceState pointing at a file that doesn't exist yet, producing a
    // "could not resume" note on every later reopen. Recorded lazily instead,
    // right after each successful turn, once the session is actually on disk.
    if (this.runner.session.id === resumeSessionId) {
      await this.context.workspaceState.update(LAST_SESSION_KEY, this.runner.session.id);
    } else {
      const sendMessage = this.runner.sendMessage.bind(this.runner);
      this.runner.sendMessage = async (text, images) => {
        await sendMessage(text, images);
        await this.context.workspaceState.update(LAST_SESSION_KEY, this.runner!.session.id);
      };
    }
    return createChatMessageHandler(this.runner, resolvePending, post);
  }
}
