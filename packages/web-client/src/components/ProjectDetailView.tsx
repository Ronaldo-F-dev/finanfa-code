import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";
import { ModelPicker, type ModelOption } from "./ModelPicker";
import { EffortSelector } from "./EffortSelector";
import type { Attachment } from "../hooks/useAgentSocket";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Real, reported gap: starting a chat from inside a project only ever
 * offered a bare textarea + "Start chat" — no model/effort choice, no
 * file/image attach, no web-search/image-gen/deep-research toggles, even
 * though the main chat composer (App.tsx) has all of these. There's no
 * live WebSocket connection yet at this point (a session only exists once
 * the first message is actually sent), so these choices are captured here
 * and threaded through onStartChat to be applied right after the fresh
 * connection opens, the same way a session's own "default effort"
 * preference already gets applied post-connect.
 */
export interface StartChatOptions {
  model?: string;
  family?: string;
  baseUrl?: string;
  effort?: string;
  webSearchEnabled: boolean;
  imageGenEnabled: boolean;
  deepResearch: boolean;
  images?: Attachment[];
}

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
  onStartChat: (firstMessage: string, options: StartChatOptions) => void;
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
  const attachInputRef = useRef<HTMLInputElement>(null);

  // Same model/effort-tier choice this project's chat will actually start
  // on — captured here (no live connection to switch yet) and applied
  // right after the fresh connection opens, via onStartChat's options.
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("");
  const [selection, setSelection] = useState<
    { kind: "model"; model: string; family: string; baseUrl?: string } | { kind: "effort"; level: string } | null
  >(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [imageGenEnabled, setImageGenEnabled] = useState(true);
  const [deepResearch, setDeepResearch] = useState(false);
  const [pendingImages, setPendingImages] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);

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
    fetch(`/api/models?project=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((data: { models: ModelOption[]; defaultModel: string }) => {
        setModels(data.models);
        setModel(data.defaultModel);
        setSelection(null);
      });
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

  async function handleAttach(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        const dataBase64 = await readFileAsBase64(file);
        if (IMAGE_TYPES.includes(file.type)) {
          setPendingImages((imgs) => [...imgs, { mimeType: file.type, base64: dataBase64 }]);
        } else {
          const res = await fetch("/api/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: file.name, dataBase64, project: projectId }),
          });
          const data = await res.json();
          setComposer((prev) => (prev ? `${prev}\n` : "") + `[Attached file: ${data.path}]`);
        }
      }
    } finally {
      setUploading(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  function handleSend() {
    if (!composer.trim()) return;
    onStartChat(composer.trim(), {
      ...(selection?.kind === "model" ? { model: selection.model, family: selection.family, baseUrl: selection.baseUrl } : {}),
      ...(selection?.kind === "effort" ? { effort: selection.level } : {}),
      webSearchEnabled,
      imageGenEnabled,
      deepResearch,
      images: pendingImages.length > 0 ? pendingImages : undefined,
    });
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
            {pendingImages.length > 0 && (
              <div className="attachment-chips">
                {pendingImages.map((img, i) => (
                  <div className="attachment-chip" key={i}>
                    <img src={`data:${img.mimeType};base64,${img.base64}`} alt="attachment" />
                    <button onClick={() => setPendingImages((imgs) => imgs.filter((_, idx) => idx !== i))}>×</button>
                  </div>
                ))}
              </div>
            )}
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
              <div className="composer-toolbar-left">
                <input ref={attachInputRef} type="file" multiple hidden onChange={(e) => handleAttach(e.target.files)} />
                <button
                  className="btn btn-ghost attach-btn"
                  onClick={() => attachInputRef.current?.click()}
                  disabled={uploading}
                  title={t("app.attachTitle")}
                >
                  📎
                </button>
                <button
                  className={`btn btn-toggle ${webSearchEnabled ? "btn-toggle-on" : ""}`}
                  onClick={() => setWebSearchEnabled((v) => !v)}
                  title={webSearchEnabled ? t("app.webOnTitle") : t("app.webOffTitle")}
                >
                  {t("app.web")}
                </button>
                <button
                  className={`btn btn-toggle ${imageGenEnabled ? "btn-toggle-on" : ""}`}
                  onClick={() => setImageGenEnabled((v) => !v)}
                  title={imageGenEnabled ? t("app.imageOnTitle") : t("app.imageOffTitle")}
                >
                  {t("app.image")}
                </button>
                <button
                  className={`btn btn-toggle ${deepResearch ? "btn-toggle-on" : ""}`}
                  onClick={() => setDeepResearch((v) => !v)}
                  title={t("app.deepResearchTitle")}
                >
                  {t("app.deepResearch")}
                </button>
                <ModelPicker
                  models={models}
                  model={model}
                  onChange={(m, family, baseUrl) => {
                    setModel(m);
                    setSelection({ kind: "model", model: m, family, baseUrl });
                  }}
                  onNeedsKey={() => {}}
                />
                <EffortSelector
                  currentEffort={selection?.kind === "effort" ? selection.level : undefined}
                  needsDownload={null}
                  onSelect={(level) => setSelection({ kind: "effort", level })}
                  onDismissNeedsDownload={() => {}}
                />
              </div>
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
