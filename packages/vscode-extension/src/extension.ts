import * as vscode from "vscode";
import { ChatViewProvider } from "./webview/chat-view-provider.js";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri, context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("finanfa.chatView", provider));
}

export function deactivate(): void {
  // Each ChatViewProvider instance disposes its own SessionRunner on
  // webviewView.onDidDispose — nothing extra to await here.
}
