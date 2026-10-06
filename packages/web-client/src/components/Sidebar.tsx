import { useEffect, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";
import { Icon } from "./Icon";

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
  onOpenApprovals,
  onOpenTodos,
  onOpenChannels,
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
  onOpenApprovals: () => void;
  onOpenTodos: () => void;
  onOpenChannels: () => void;
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
        <Icon name="newChat" />
          <span>{t("sidebar.newChat")}</span>
      </button>
      <button className="sidebar-project" onClick={onOpenProjects} title={t("sidebar.browseProjects")}>
        <Icon name="projects" />
          <span>{t("sidebar.projects")}</span>
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
          <Icon name="memory" />
          <span>{t("sidebar.memory")}</span>
        </button>
        <button className="sidebar-settings" onClick={onOpenMcp}>
          <Icon name="connectors" />
          <span>{t("sidebar.connectors")}</span>
        </button>
        <button className="sidebar-settings" onClick={onOpenModels}>
          <Icon name="models" />
          <span>{t("sidebar.models")}</span>
        </button>
        <button className="sidebar-settings" onClick={onOpenTools}>
          <Icon name="tools" />
          <span>{t("sidebar.tools")}</span>
        </button>
        <button className="sidebar-settings" onClick={onOpenApprovals}>
          <Icon name="approvals" />
          <span>{t("sidebar.approvals")}</span>
        </button>
        <button className="sidebar-settings" onClick={onOpenTodos}>
          <Icon name="tasks" />
          <span>{t("sidebar.todos")}</span>
        </button>
        <button className="sidebar-settings" onClick={onOpenChannels}>
          <Icon name="channels" />
          <span>{t("sidebar.channels")}</span>
        </button>
        <button className="sidebar-settings" onClick={onOpenSettings}>
          <Icon name="settings" />
          <span>{t("sidebar.settings")}</span>
        </button>
      </div>
    </aside>
  );
}
