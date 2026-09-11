function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

/**
 * Minimal, dependency-free webview — plain HTML/JS, not React yet. Proves
 * the postMessage round-trip against the real engine end to end (steps
 * 3+4 of the plan) before the full React port (ChatMessage, Composer,
 * ModelPicker, PermissionModal — steps 5+) replaces it. Deliberately
 * inline `<script>` (no bundle to reference via asWebviewUri yet).
 */
export function renderChatHtml(webview: { cspSource: string }): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
  <title>finanfa-code</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }
    #log { flex: 1; overflow-y: auto; padding: 8px; }
    .msg { margin-bottom: 8px; white-space: pre-wrap; }
    .msg.user { color: var(--vscode-textLink-foreground); }
    .msg.error { color: var(--vscode-errorForeground); }
    .msg.system { opacity: 0.7; font-style: italic; }
    .msg.tool_call { opacity: 0.8; font-family: var(--vscode-editor-font-family); }
    #composer { display: flex; border-top: 1px solid var(--vscode-panel-border); padding: 8px; gap: 8px; }
    #input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div id="log"></div>
  <div id="composer">
    <input id="input" type="text" placeholder="Ask finanfa-code..." />
    <button id="send">Send</button>
    <button id="stop" style="display:none;">Stop</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const log = document.getElementById("log");
    const input = document.getElementById("input");
    const sendBtn = document.getElementById("send");
    const stopBtn = document.getElementById("stop");
    let streamingEl = null;

    function appendLine(cls, text) {
      const div = document.createElement("div");
      div.className = "msg " + cls;
      div.textContent = text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      return div;
    }

    function send() {
      const text = input.value.trim();
      if (!text) return;
      appendLine("user", text);
      vscode.postMessage({ type: "user_message", text });
      input.value = "";
      sendBtn.style.display = "none";
      stopBtn.style.display = "inline-block";
    }
    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    stopBtn.addEventListener("click", () => vscode.postMessage({ type: "interrupt" }));

    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "assistant_delta":
          if (!streamingEl) streamingEl = appendLine("assistant", "");
          streamingEl.textContent += msg.text;
          log.scrollTop = log.scrollHeight;
          break;
        case "assistant_end":
          streamingEl = null;
          break;
        case "tool_call":
          appendLine("tool_call", "▸ " + msg.toolName + ": " + (msg.description || ""));
          break;
        case "system":
          appendLine("system", msg.text);
          break;
        case "error":
          appendLine("error", msg.text);
          break;
        case "busy":
          sendBtn.style.display = msg.busy ? "none" : "inline-block";
          stopBtn.style.display = msg.busy ? "inline-block" : "none";
          break;
        case "history":
          for (const item of msg.messages) appendLine(item.role, item.content);
          break;
        case "session_info":
          document.title = "finanfa-code — " + msg.model;
          break;
        default:
          break;
      }
    });

    vscode.postMessage({ type: "webview_ready" });
  </script>
</body>
</html>`;
}
