import { useEffect, useState } from "react";

export interface SessionListItem {
  id: string;
  title?: string;
  mtime: string;
}

export function Sidebar({
  activeSessionId,
  projectId,
  projectName,
  refreshToken,
  onSelect,
  onNewChat,
  onOpenSettings,
  onOpenMcp,
  onOpenProjects,
}: {
  activeSessionId: string | undefined;
  projectId: string | undefined;
  projectName?: string;
  refreshToken: number;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenMcp: () => void;
  onOpenProjects: () => void;
}) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);

  useEffect(() => {
    const qs = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
    fetch(`/api/sessions${qs}`)
      .then((r) => r.json())
      .then((data: { sessions: SessionListItem[] }) => setSessions(data.sessions))
      .catch(() => setSessions([]));
  }, [refreshToken, activeSessionId, projectId]);

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const qs = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
    await fetch(`/api/sessions/${id}${qs}`, { method: "DELETE" });
    setSessions((s) => s.filter((session) => session.id !== id));
    if (id === activeSessionId) onNewChat();
  }

  return (
    <aside className="sidebar">
      <button className="sidebar-project" onClick={onOpenProjects} title="Switch project">
        📁 {projectName ?? "Default workspace"}
      </button>
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
