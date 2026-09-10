import * as vscode from "vscode";

// Step 1 of the plan (see /home/kps-groupe-benin/.claude/plans/concurrent-foraging-sprout.md):
// a static, no-engine skeleton — validates activation, the Activity Bar
// container/icon, and the webview's CSP/nonce plumbing before any of
// @finanfa/core is wired in (step 2+). Deliberately has no dependency on
// the engine yet, so this step is testable in complete isolation.

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    // No external JS/CSS yet in this step — the real webview-ui bundle
    // (React, useAgentBridge, ChatMessage, ...) arrives in step 3+ and will
    // be referenced here via webview.asWebviewUri(...), never a raw file://
    // path (blocked silently by CSP otherwise).
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>finanfa-code</title>
</head>
<body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px;">
  <p>finanfa-code — chat panel skeleton (step 1). Engine wiring lands next.</p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: "webview_ready" });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("finanfa.chatView", provider));
}

export function deactivate(): void {
  // No engine wired up yet in this step — nothing to dispose.
}
