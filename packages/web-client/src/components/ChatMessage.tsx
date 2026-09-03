import { marked } from "marked";
import type { TimelineItem } from "../hooks/useAgentSocket";

marked.setOptions({ breaks: true });

function withCopyButtons(html: string): string {
  // Injected as the <pre>'s first child, positioned via CSS (absolute,
  // top-right) rather than DOM order — simplest way to add a per-block
  // "Copy" affordance without a full markdown-renderer plugin.
  return html.replace(/<pre>/g, '<pre><button type="button" class="code-copy-btn" data-code-copy>Copy</button>');
}

function handleMarkdownClick(e: React.MouseEvent<HTMLDivElement>): void {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-code-copy]");
  if (!btn) return;
  const pre = btn.closest("pre");
  const code = pre?.querySelector("code");
  const text = (code ?? pre)?.textContent?.replace(/^Copy/, "") ?? "";
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  });
}

export function ChatMessageView({ item }: { item: TimelineItem }) {
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

  return (
    <div className="row row-log">
      <div className={`log-line log-${item.variant}`}>{item.text}</div>
    </div>
  );
}
