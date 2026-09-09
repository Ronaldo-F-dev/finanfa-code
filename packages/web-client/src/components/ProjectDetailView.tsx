import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";

interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  fileCount: number;
}

interface SessionListItem {
  id: string;
  title?: string;
  mtime: string;
}

interface KnowledgeFile {
  name: string;
  size: number;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function ProjectDetailView({
  projectId,
  onBack,
  onOpenChat,
  onStartChat,
  onDeleted,
}: {
  projectId: string;
  onBack: () => void;
  onOpenChat: (sessionId: string) => void;
  onStartChat: (firstMessage: string) => void;
  onDeleted: () => void;
}) {
  const { t } = useLanguage();
  const [project, setProject] = useState<ProjectMeta | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [instructions, setInstructions] = useState("");
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [composer, setComposer] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function refreshAll() {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: { projects: ProjectMeta[] }) => setProject(data.projects.find((p) => p.id === projectId) ?? null));
    fetch(`/api/sessions?project=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((data: { sessions: SessionListItem[] }) => setSessions(data.sessions));
    fetch(`/api/projects/${projectId}/instructions`)
      .then((r) => r.json())
      .then((data: { content: string }) => setInstructions(data.content));
    fetch(`/api/projects/${projectId}/files`)
      .then((r) => r.json())
      .then((data: { files: KnowledgeFile[] }) => setFiles(data.files));
  }

  useEffect(refreshAll, [projectId]);

  async function saveInstructions() {
    await fetch(`/api/projects/${projectId}/instructions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: instructions }),
    });
    setInstructionsDirty(false);
  }

  async function handleUpload(fileList: FileList | null) {
    if (!fileList) return;
    for (const file of Array.from(fileList)) {
      const dataBase64 = await readFileAsBase64(file);
      await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, dataBase64 }),
      });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
    refreshAll();
  }

  async function handleDeleteFile(name: string) {
    await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(name)}`, { method: "DELETE" });
    setFiles((f) => f.filter((file) => file.name !== name));
  }

  async function handleDeleteProject() {
    await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
    onDeleted();
  }

  function handleSend() {
    if (!composer.trim()) return;
    onStartChat(composer.trim());
  }

  if (!project) return null;

  return (
    <div className="page">
      <div className="breadcrumb">
        <span className="breadcrumb-link" onClick={onBack}>
          {t("projectDetail.breadcrumb")}
        </span>{" "}
        / {project.name}
      </div>

      <div className="page-header">
        <h1>{project.name}</h1>
        <div className="page-header-actions">
          <a className="btn btn-ghost" href={`/api/projects/${projectId}/download`} download>
            {t("projectDetail.downloadSource")}
          </a>
          {project.id !== "default" && (
            <button className="btn btn-deny" onClick={handleDeleteProject}>
              {t("projectDetail.deleteProject")}
            </button>
          )}
        </div>
      </div>

      <div className="project-detail-layout">
        <div className="project-detail-main">
          <div className="composer-box project-start-composer">
            <textarea
              className="composer-input"
              placeholder={t("projectDetail.startChatPlaceholder", { name: project.name })}
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <div className="composer-toolbar">
              <span />
              <button className="btn btn-send" onClick={handleSend} disabled={!composer.trim()}>
                {t("projectDetail.startChat")}
              </button>
            </div>
          </div>

          <div className="page-section-label">{t("projectDetail.chatsInProject")}</div>
          <div className="project-chat-list">
            {sessions.map((s) => (
              <div key={s.id} className="sidebar-item project-chat-row" onClick={() => onOpenChat(s.id)}>
                <span className="sidebar-item-title">{s.title ?? t("sidebar.newChatFallback")}</span>
              </div>
            ))}
            {sessions.length === 0 && <div className="sidebar-empty">{t("projectDetail.noChats")}</div>}
          </div>
        </div>

        <div className="project-detail-side">
          <div className="side-panel">
            <div className="side-panel-title">{t("projectDetail.instructions")}</div>
            <p className="settings-hint">{t("projectDetail.instructionsHint")}</p>
            <textarea
              className="instructions-textarea"
              placeholder={t("projectDetail.instructionsPlaceholder")}
              value={instructions}
              onChange={(e) => {
                setInstructions(e.target.value);
                setInstructionsDirty(true);
              }}
            />
            {instructionsDirty && (
              <button className="btn btn-allow" onClick={saveInstructions}>
                {t("projectDetail.saveInstructions")}
              </button>
            )}
          </div>

          <div className="side-panel">
            <div className="side-panel-title">{t("projectDetail.knowledge")}</div>
            <p className="settings-hint">{t("projectDetail.knowledgeHint")}</p>
            <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => handleUpload(e.target.files)} />
            <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}>
              {t("projectDetail.addFiles")}
            </button>
            {files.map((f) => (
              <div className="project-file-row" key={f.name}>
                <span>{f.name}</span>
                <button onClick={() => handleDeleteFile(f.name)}>×</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
