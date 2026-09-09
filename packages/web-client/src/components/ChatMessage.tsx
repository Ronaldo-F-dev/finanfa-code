import { marked } from "marked";
import type { TimelineItem, ToolRiskLevel } from "../hooks/useAgentSocket";
import { useLanguage } from "../i18n/LanguageContext";

marked.setOptions({ breaks: true });

const TOOL_RISK_ICON: Record<ToolRiskLevel, string> = { safe: "›", ask: "◆", dangerous: "▲" };

function withCopyButtons(html: string, copyLabel: string): string {
  // Injected as the <pre>'s first child, positioned via CSS (absolute,
  // top-right) rather than DOM order — simplest way to add a per-block
  // "Copy" affordance without a full markdown-renderer plugin.
  return html.replace(/<pre>/g, `<pre><button type="button" class="code-copy-btn" data-code-copy>${copyLabel}</button>`);
}

function handleMarkdownClick(e: React.MouseEvent<HTMLDivElement>, copyLabel: string, copiedLabel: string): void {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-code-copy]");
  if (!btn) return;
  const pre = btn.closest("pre");
  const code = pre?.querySelector("code");
  const text = (code ?? pre)?.textContent?.replace(new RegExp(`^${copyLabel}`), "") ?? "";
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = copiedLabel;
    setTimeout(() => {
      btn.textContent = copyLabel;
    }, 1500);
  });
}

export function ChatMessageView({ item, projectId }: { item: TimelineItem; projectId?: string }) {
  const { t } = useLanguage();
  if (item.kind === "user") {
    return (
      <div className="row row-user">
        <div className="bubble bubble-user">
          {item.images && item.images.length > 0 && (
            <div className="bubble-images">
              {item.images.map((img, i) => (
                <img key={i} src={`data:${img.mimeType};base64,${img.base64}`} alt="attachment" />
              ))}
            </div>
          )}
          {item.text}
        </div>
      </div>
    );
  }

  if (item.kind === "assistant") {
    const copyLabel = t("chatMessage.copy");
    const html = withCopyButtons(marked.parse(item.text || (item.streaming ? "" : "")) as string, copyLabel);
    return (
      <div className="row row-assistant">
        <div className="avatar">f</div>
        <div className="bubble bubble-assistant">
          <div
            className="markdown"
            onClick={(e) => handleMarkdownClick(e, copyLabel, t("chatMessage.copied"))}
            dangerouslySetInnerHTML={{ __html: html }}
          />
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
    const qs = new URLSearchParams({ path: item.path });
    if (projectId) qs.set("project", projectId);
    const src = `/api/workspace-file?${qs.toString()}`;
    return (
      <div className="row row-log">
        {item.mediaKind === "audio" ? (
          <audio className="media-audio" controls src={src} />
        ) : (
          <img className="media-image" src={src} alt={item.path} />
        )}
      </div>
    );
  }

  return (
    <div className="row row-log">
      <div className={`log-line log-${item.variant}`}>{item.text}</div>
    </div>
  );
}
