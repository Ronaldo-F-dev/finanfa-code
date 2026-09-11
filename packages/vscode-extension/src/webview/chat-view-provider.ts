import * as vscode from "vscode";
import { createSessionRunner, type SessionRunner } from "../engine/session-runner.js";
import { createVscodeUiAdapter } from "../engine/vscode-ui-adapter.js";
import { createChatMessageHandler, type WebviewMessage } from "../engine/message-handler.js";
import { getNonce } from "./nonce.js";

const LAST_SESSION_KEY = "finanfa.lastSessionId";

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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = renderChatHtml(webviewView.webview, this.extensionUri);

    const post = (msg: Record<string, unknown>): void => {
      void webviewView.webview.postMessage(msg);
    };

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      // needs_api_key intercepted here, not routed to message-handler.ts:
      // it's a pure "open a native VS Code notification" concern
      // (vscode.window.showInformationMessage), not engine wiring — there's
      // no Settings modal in this phase (out of scope), so picking a model
      // that needs a key used to just silently do nothing.
      if (msg.type === "needs_api_key") {
        void vscode.window.showInformationMessage(
          `Le modèle "${msg.model}" nécessite une clé API. Ajoutez-la dans ~/.finanfa-code/config.json (ou <projet>/.finanfa-code/config.json), champ "apiKey", puis rouvrez ce panneau.`,
        );
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

  private async createHandler(post: (msg: Record<string, unknown>) => void): Promise<(msg: WebviewMessage) => Promise<void>> {
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
    // --continue du CLI.
    const resumeSessionId = this.context.workspaceState.get<string>(LAST_SESSION_KEY);
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
