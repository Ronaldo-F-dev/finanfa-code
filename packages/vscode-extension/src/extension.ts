import "./dom-shims.js";
import * as vscode from "vscode";
import { ChatViewProvider } from "./webview/chat-view-provider.js";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri, context);
  // retainContextWhenHidden: without it, switching away from the panel (or
  // just closing the Activity Bar sidebar) tears down the webview's DOM/JS
  // entirely — any assistant_delta/tool_call posted while hidden is lost,
  // so reopening it looks like the generation silently died mid-stream even
  // though the real turn is still running in the extension host. Decided
  // and documented in the plan's own §5 risk list; the cost (one retained
  // webview, one workspace) is negligible.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("finanfa.chatView", provider, { webviewOptions: { retainContextWhenHidden: true } }),
  );
}

export function deactivate(): void {
  // Each ChatViewProvider instance disposes its own SessionRunner on
  // webviewView.onDidDispose — nothing extra to await here.
}
