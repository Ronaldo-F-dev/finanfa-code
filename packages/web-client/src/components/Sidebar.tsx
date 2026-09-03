import { useEffect, useState } from "react";

export interface SessionListItem {
  id: string;
  title?: string;
  mtime: string;
}

export function Sidebar({
  activeSessionId,
  refreshToken,
  onSelect,
  onNewChat,
  onOpenSettings,
  onOpenMcp,
}: {
  activeSessionId: string | undefined;
  refreshToken: number;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenMcp: () => void;
}) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data: { sessions: SessionListItem[] }) => setSessions(data.sessions))
      .catch(() => setSessions([]));
  }, [refreshToken, activeSessionId]);

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    setSessions((s) => s.filter((session) => session.id !== id));
    if (id === activeSessionId) onNewChat();
  }

  return (
    <aside className="sidebar">
      <button className="sidebar-new" onClick={onNewChat}>
        + New chat
      </button>

      <div className="sidebar-section-label">Chats</div>
      <div className="sidebar-list">
        {sessions.map((s) => (
          <div key={s.id} className={`sidebar-item ${s.id === activeSessionId ? "sidebar-item-active" : ""}`} onClick={() => onSelect(s.id)}>
            <span className="sidebar-item-title">{s.title ?? "New chat"}</span>
            <button className="sidebar-item-delete" onClick={(e) => handleDelete(e, s.id)} title="Delete">
              ×
            </button>
          </div>
        ))}
        {sessions.length === 0 && <div className="sidebar-empty">No chats yet</div>}
      </div>

      <div className="sidebar-menu">
        <button className="sidebar-settings" onClick={onOpenMcp}>
          ⇄ MCP servers
        </button>
        <button className="sidebar-settings" onClick={onOpenSettings}>
          ⚙ Settings
        </button>
      </div>
    </aside>
  );
}
