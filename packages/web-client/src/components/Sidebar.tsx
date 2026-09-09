import { useEffect, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";

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
  mobileOpen,
  onSelect,
  onNewChat,
  onOpenSettings,
  onOpenMcp,
  onOpenProjects,
  onOpenMemory,
  onOpenModels,
  onOpenTools,
}: {
  activeSessionId: string | undefined;
  projectId: string | undefined;
  projectName?: string;
  refreshToken: number;
  mobileOpen?: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenMcp: () => void;
  onOpenProjects: () => void;
  onOpenMemory: () => void;
  onOpenModels: () => void;
  onOpenTools: () => void;
}) {
  const { t } = useLanguage();
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
    <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
      <button className="sidebar-new" onClick={onNewChat}>
        {t("sidebar.newChat")}
      </button>
      <button className="sidebar-project" onClick={onOpenProjects} title={t("sidebar.browseProjects")}>
        {t("sidebar.projects")}
        {projectName ? ` — ${projectName}` : ""}
      </button>

      <div className="sidebar-section-label">{t("sidebar.chats")}</div>
      <div className="sidebar-list">
        {sessions.map((s) => (
          <div key={s.id} className={`sidebar-item ${s.id === activeSessionId ? "sidebar-item-active" : ""}`} onClick={() => onSelect(s.id)}>
            <span className="sidebar-item-title">{s.title ?? t("sidebar.newChatFallback")}</span>
            <button className="sidebar-item-delete" onClick={(e) => handleDelete(e, s.id)} title={t("sidebar.delete")}>
              ×
            </button>
          </div>
        ))}
        {sessions.length === 0 && <div className="sidebar-empty">{t("sidebar.noChats")}</div>}
      </div>

      <div className="sidebar-section-label sidebar-workspace-label">{t("sidebar.workspace")}</div>
      <div className="sidebar-menu">
        <button className="sidebar-settings" onClick={onOpenMemory}>
          {t("sidebar.memory")}
        </button>
        <button className="sidebar-settings" onClick={onOpenMcp}>
          {t("sidebar.connectors")}
        </button>
        <button className="sidebar-settings" onClick={onOpenModels}>
          {t("sidebar.models")}
        </button>
        <button className="sidebar-settings" onClick={onOpenTools}>
          {t("sidebar.tools")}
        </button>
        <button className="sidebar-settings" onClick={onOpenSettings}>
          {t("sidebar.settings")}
        </button>
      </div>
    </aside>
  );
}
