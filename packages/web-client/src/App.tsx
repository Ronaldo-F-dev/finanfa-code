import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentSocket, type Attachment } from "./hooks/useAgentSocket";
import { ChatMessageView } from "./components/ChatMessage";
import { ModelPicker, type ModelOption } from "./components/ModelPicker";
import { PermissionModal } from "./components/PermissionModal";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";
import { McpPanel } from "./components/McpPanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { ProjectsListView } from "./components/ProjectsListView";
import { ProjectDetailView } from "./components/ProjectDetailView";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type View = { kind: "chat" } | { kind: "projects" } | { kind: "project"; id: string };

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const [view, setView] = useState<View>({ kind: "chat" });
  const [models, setModels] = useState<ModelOption[]>([]);
  // connectModel only ever feeds the WebSocket's connection query string —
  // it changes exactly when we WANT a reconnect (initial default arriving,
  // an explicit new chat). model is purely display/selection state, kept in
  // sync from the server's own session_info once connected. The two used to
  // be the same state, so picking a model mid-chat (meant to send a live
  // set_model message) also fed straight back into the connection's own
  // effect dependency and silently reconnected/dropped the session instead
  // — a real bug caught by actually clicking the picker, not just reading
  // the code.
  const [connectModel, setConnectModel] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  // undefined = the "default" workspace (the folder the server was started
  // against) — the only workspace that existed before Projects, kept as the
  // implicit default rather than requiring everyone to create one.
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);
  const [projectName, setProjectName] = useState<string | undefined>(undefined);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [imageGenEnabled, setImageGenEnabled] = useState(true);
  const [deepResearch, setDeepResearch] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [sidebarRefreshToken, setSidebarRefreshToken] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingFirstMessageRef = useRef<string | null>(null);

  useEffect(() => {
    const qs = activeProjectId ? `?project=${encodeURIComponent(activeProjectId)}` : "";
    fetch(`/api/models${qs}`)
      .then((r) => r.json())
      .then((data: { models: ModelOption[]; defaultModel: string }) => {
        setModels(data.models);
        setConnectModel(data.defaultModel);
        setModel(data.defaultModel);
      })
      .catch(() => {
        setModels([]);
        setConnectModel("default");
        setModel("default");
      });
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) {
      setProjectName(undefined);
      return;
    }
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: { projects: { id: string; name: string }[] }) => setProjectName(data.projects.find((p) => p.id === activeProjectId)?.name));
  }, [activeProjectId]);

  const onTitled = useCallback(() => setSidebarRefreshToken((t) => t + 1), []);
  const {
    connected,
    timeline,
    busy,
    permissionRequest,
    status,
    sessionInfo,
    mcpServers,
    mcpLoaded,
    modelUnavailable,
    sendMessage,
    answerPermission,
    interrupt,
    reconnect,
    switchModel,
    dismissModelUnavailable,
    mcpConnect,
    mcpToggle,
    mcpReload,
    setToolEnabled,
  } = useAgentSocket(connectModel || undefined, activeSessionId, activeProjectId, onTitled);

  // The server's session_info is the source of truth for what model the
  // *active connection* is actually using — after a resume, after a live
  // switchModel round-trip, or on first connect. Never write into
  // connectModel here, only the display-facing `model`.
  //
  // Deliberately NOT syncing activeSessionId from sessionInfo.id here (a
  // real, serious bug this used to have): activeSessionId feeds the
  // WebSocket's own ?session= query param, so "the server told us this
  // connection's session id" fed straight back into "reconnect using this
  // session id" — for a brand-new, not-yet-persisted chat, that reconnect's
  // resume() always 404s, falls back to yet another new session, whose
  // session_info again triggered the same sync — an infinite reconnect loop
  // invisible in the UI (it looks merely "connected") but hammering the
  // server with a fresh connectMcpServers() every few hundred ms. Caught by
  // actually watching the raw WebSocket frames, not by reading this code.
  // Sidebar highlighting uses sessionInfo.id directly instead (below).
  useEffect(() => {
    if (sessionInfo?.model && sessionInfo.model !== model) setModel(sessionInfo.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionInfo?.model]);

  // Fires the message a project's own "start chat" composer queued, once the
  // freshly (re)connected socket is actually ready to receive it.
  useEffect(() => {
    if (connected && pendingFirstMessageRef.current) {
      sendMessage(pendingFirstMessageRef.current);
      pendingFirstMessageRef.current = null;
    }
  }, [connected, sendMessage]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [timeline, busy]);

  function handleNewChat() {
    setView({ kind: "chat" });
    const wasAlreadyFresh = activeSessionId === undefined;
    setActiveSessionId(undefined);
    // Whatever's currently selected becomes the new chat's starting model.
    setConnectModel(model);
    if (wasAlreadyFresh) reconnect();
  }

  function handleSelectSession(id: string) {
    setView({ kind: "chat" });
    setActiveSessionId(id);
  }

  function handleSelectProject(id: string | undefined) {
    setView({ kind: "chat" });
    setActiveProjectId(id);
    setActiveSessionId(undefined); // a session belongs to exactly one project's cwd
  }

  function handleStartChatFromProject(projectId: string, firstMessage: string) {
    pendingFirstMessageRef.current = firstMessage;
    setActiveProjectId(projectId);
    setActiveSessionId(undefined);
    setView({ kind: "chat" });
  }

  function handleSend() {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || busy.active) return;
    sendMessage(text || "(see attached image)", pendingImages.length > 0 ? pendingImages : undefined, deepResearch);
    setInput("");
    setPendingImages([]);
  }

  function toggleWebSearch() {
    const next = !webSearchEnabled;
    setWebSearchEnabled(next);
    setToolEnabled("web_search", next);
  }

  function toggleImageGen() {
    const next = !imageGenEnabled;
    setImageGenEnabled(next);
    setToolEnabled("generate_2d", next);
    setToolEnabled("generate_3d", next);
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const base64 = await readFileAsBase64(file);
        if (IMAGE_TYPES.includes(file.type)) {
          setPendingImages((imgs) => [...imgs, { mimeType: file.type, base64 }]);
        } else {
          // Non-image files aren't sent inline — uploaded to the project and
          // referenced by path instead, so the model reaches them through
          // its own read_file/read_document/view_image tools like any other
          // file in the project, rather than a separate ad hoc upload path.
          const res = await fetch("/api/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: file.name, dataBase64: base64, project: activeProjectId }),
          });
          const data = await res.json();
          setInput((prev) => (prev ? `${prev}\n` : "") + `[Attached file: ${data.path}]`);
        }
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="app-shell">
      <button className="sidebar-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open menu" title="Menu">
        ☰
      </button>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <Sidebar
        mobileOpen={sidebarOpen}
        activeSessionId={sessionInfo?.id ?? activeSessionId}
        projectId={activeProjectId}
        projectName={projectName}
        refreshToken={sidebarRefreshToken}
        onSelect={(id) => {
          handleSelectSession(id);
          setSidebarOpen(false);
        }}
        onNewChat={() => {
          handleNewChat();
          setSidebarOpen(false);
        }}
        onOpenSettings={() => {
          setSettingsOpen(true);
          setSidebarOpen(false);
        }}
        onOpenMcp={() => {
          setMcpOpen(true);
          setSidebarOpen(false);
        }}
        onOpenProjects={() => {
          setView({ kind: "projects" });
          setSidebarOpen(false);
        }}
        onOpenMemory={() => {
          setMemoryOpen(true);
          setSidebarOpen(false);
        }}
      />

      {view.kind === "projects" && <ProjectsListView onOpenProject={(id) => setView({ kind: "project", id })} />}

      {view.kind === "project" && (
        <ProjectDetailView
          projectId={view.id}
          onBack={() => setView({ kind: "projects" })}
          onOpenChat={(sessionId) => {
            setActiveProjectId(view.id);
            setActiveSessionId(sessionId);
            setView({ kind: "chat" });
          }}
          onStartChat={(firstMessage) => handleStartChatFromProject(view.id, firstMessage)}
          onDeleted={() => {
            if (activeProjectId === view.id) handleSelectProject(undefined);
            setView({ kind: "projects" });
          }}
        />
      )}

      {view.kind === "chat" && (
        <div className="app">
          <header className="topbar">
            <div className="brand">{sessionInfo?.title ?? "finanfa AI"}</div>
            <div className="topbar-right">
              {status && (
                <span className="cost-pill">
                  {status.tokens.toLocaleString()} tok · ${status.costUsd.toFixed(4)}
                </span>
              )}
              <span className={`conn-dot ${connected ? "conn-on" : "conn-off"}`} title={connected ? "connected" : "disconnected"} />
            </div>
          </header>

          {modelUnavailable && (
            <div className="inline-banner">
              <span>{modelUnavailable.message}</span>
              <div className="inline-banner-actions">
                <button className="btn btn-ghost" onClick={() => setSettingsOpen(true)}>
                  Open Settings
                </button>
                <button className="btn btn-ghost" onClick={dismissModelUnavailable}>
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <main className="timeline" ref={scrollRef}>
            {timeline.length === 0 && (
              <div className="empty-state">
                <div className="empty-title">finanfa AI</div>
                <div className="empty-sub">Ask it to read, edit, run, or build something in this project.</div>
              </div>
            )}
            {timeline.map((item) => (
              <ChatMessageView key={item.id} item={item} />
            ))}
            {busy.active && (
              <div className="row row-log">
                <div className="log-line log-busy">
                  <span className="spinner" /> {busy.label ?? "working"}…
                </div>
              </div>
            )}
          </main>

          <footer className="composer">
            <div className="composer-box">
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
                placeholder={connected ? "Message finanfa AI…" : "Connecting…"}
                value={input}
                disabled={!connected}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <div className="composer-toolbar">
                <div className="composer-toolbar-left">
                  <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
                  <button className="btn btn-ghost attach-btn" onClick={() => fileInputRef.current?.click()} disabled={!connected || uploading} title="Attach image or file">
                    📎
                  </button>
                  <button
                    className={`btn btn-toggle ${webSearchEnabled ? "btn-toggle-on" : ""}`}
                    onClick={toggleWebSearch}
                    title={webSearchEnabled ? "Web search allowed — click to disable" : "Web search disabled — click to enable"}
                  >
                    🌐 Web
                  </button>
                  <button
                    className={`btn btn-toggle ${imageGenEnabled ? "btn-toggle-on" : ""}`}
                    onClick={toggleImageGen}
                    title={imageGenEnabled ? "Image generation allowed — click to disable" : "Image generation disabled — click to enable"}
                  >
                    🖼️ Image
                  </button>
                  <button
                    className={`btn btn-toggle ${deepResearch ? "btn-toggle-on" : ""}`}
                    onClick={() => setDeepResearch((v) => !v)}
                    title="Deep research: push the agent to search thoroughly across multiple sources before answering"
                  >
                    🔎 Deep research
                  </button>
                  <ModelPicker
                    models={models}
                    model={model}
                    onChange={(m, family) => switchModel(m, family)}
                    onNeedsKey={() => setSettingsOpen(true)}
                  />
                </div>
                {busy.active ? (
                  <button className="btn btn-stop" onClick={interrupt}>
                    Stop
                  </button>
                ) : (
                  <button className="btn btn-send" onClick={handleSend} disabled={!connected || (!input.trim() && pendingImages.length === 0)}>
                    Send
                  </button>
                )}
              </div>
            </div>
            <div className="composer-hint">Enter to send · Shift+Enter for a new line</div>
          </footer>
        </div>
      )}

      {permissionRequest && <PermissionModal request={permissionRequest} onAnswer={(answer) => answerPermission(permissionRequest.requestId, answer)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {mcpOpen && (
        <McpPanel servers={mcpServers} loaded={mcpLoaded} onClose={() => setMcpOpen(false)} onConnect={mcpConnect} onToggle={mcpToggle} onReload={mcpReload} />
      )}
      {memoryOpen && <MemoryPanel projectId={activeProjectId} onClose={() => setMemoryOpen(false)} />}
    </div>
  );
}
