import * as vscode from "vscode";
import { createSessionRunner, type SessionRunner } from "../engine/session-runner.js";
import { createVscodeUiAdapter } from "../engine/vscode-ui-adapter.js";
import { createChatMessageHandler, type WebviewMessage } from "../engine/message-handler.js";
import { renderChatHtml } from "./html.js";

const LAST_SESSION_KEY = "finanfa.lastSessionId";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private runner?: SessionRunner;
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
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = renderChatHtml(webviewView.webview);

    const post = (msg: Record<string, unknown>): void => {
      void webviewView.webview.postMessage(msg);
    };

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      // Deliberately not awaited/chained in strict FIFO order here — see
      // message-handler.ts's own comment on the "interrupt" branch for why
      // that matters once more message types are wired in.
      void this.ensureReady(post).then((handle) => handle(msg));
    });

    webviewView.onDidDispose(() => {
      void this.runner?.dispose();
      this.runner = undefined;
      this.handlerPromise = undefined;
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

    const { adapter, resolvePending } = createVscodeUiAdapter(post);
    // Reprise automatique de la dernière session de ce workspace (voir le
    // plan, §2) — pas de commande à taper, contrairement au --resume/
    // --continue du CLI.
    const resumeSessionId = this.context.workspaceState.get<string>(LAST_SESSION_KEY);
    this.runner = await createSessionRunner(folder.uri.fsPath, adapter, { resumeSessionId });
    await this.context.workspaceState.update(LAST_SESSION_KEY, this.runner.session.id);
    return createChatMessageHandler(this.runner, resolvePending, post);
  }
}
