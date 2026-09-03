import { marked } from "marked";
import type { TimelineItem } from "../hooks/useAgentSocket";

marked.setOptions({ breaks: true });

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
    const html = marked.parse(item.text || (item.streaming ? "" : "")) as string;
    return (
      <div className="row row-assistant">
        <div className="avatar">f</div>
        <div className="bubble bubble-assistant">
          <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
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
