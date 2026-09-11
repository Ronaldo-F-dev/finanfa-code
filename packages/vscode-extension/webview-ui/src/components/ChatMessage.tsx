import { marked } from "marked";
import type { TimelineItem, ToolRiskLevel } from "../hooks/useAgentBridge";

marked.setOptions({ breaks: true });

const TOOL_RISK_ICON: Record<ToolRiskLevel, string> = { safe: "›", ask: "◆", dangerous: "▲" };

const COPY_LABEL = "Copier";
const COPIED_LABEL = "Copié !";

function withCopyButtons(html: string): string {
  return html.replace(/<pre>/g, `<pre><button type="button" class="code-copy-btn" data-code-copy>${COPY_LABEL}</button>`);
}

function handleMarkdownClick(e: React.MouseEvent<HTMLDivElement>): void {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-code-copy]");
  if (!btn) return;
  const pre = btn.closest("pre");
  const code = pre?.querySelector("code");
  const text = (code ?? pre)?.textContent?.replace(new RegExp(`^${COPY_LABEL}`), "") ?? "";
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = COPIED_LABEL;
    setTimeout(() => {
      btn.textContent = COPY_LABEL;
    }, 1500);
  });
}

// Port of web-client's ChatMessage.tsx — i18n stripped to hardcoded French
// strings (see the plan's i18n note), and the `media` case reads a
// pre-resolved `webviewUri` instead of building a `/api/workspace-file` URL
// (there is no HTTP server in the extension to serve local files from).
export function ChatMessageView({ item }: { item: TimelineItem }) {
  if (item.kind === "user") {
    return (
      <div className="row row-user">
        <div className="bubble bubble-user">
          {item.images && item.images.length > 0 && (
            <div className="bubble-images">
              {item.images.map((img, i) => (
                <img key={i} src={`data:${img.mimeType};base64,${img.base64}`} alt="pièce jointe" />
              ))}
            </div>
          )}
          {item.text}
        </div>
      </div>
    );
  }

  if (item.kind === "assistant") {
    const html = withCopyButtons(marked.parse(item.text || (item.streaming ? "" : "")) as string);
    return (
      <div className="row row-assistant">
        <div className="avatar">f</div>
        <div className="bubble bubble-assistant">
          <div className="markdown" onClick={handleMarkdownClick} dangerouslySetInnerHTML={{ __html: html }} />
          {item.streaming && <span className="cursor" />}
        </div>
      </div>
    );
  }

  if (item.kind === "tool_call") {
    const icon = TOOL_RISK_ICON[item.riskLevel];
    return (
      <div className="row row-log">
        <div className={`tool-call tool-call-${item.riskLevel}`}>
          <span className="tool-call-icon">{icon}</span>
          <span className="tool-call-name">{item.toolName}</span>
          {item.description && <span className="tool-call-description">{item.description}</span>}
        </div>
      </div>
    );
  }

  if (item.kind === "media") {
    const src = item.webviewUri ?? item.path;
    return (
      <div className="row row-log">
        {item.mediaKind === "audio" ? <audio className="media-audio" controls src={src} /> : <img className="media-image" src={src} alt={item.path} />}
      </div>
    );
  }

  return (
    <div className="row row-log">
      <div className={`log-line log-${item.variant}`}>{item.text}</div>
    </div>
  );
}
