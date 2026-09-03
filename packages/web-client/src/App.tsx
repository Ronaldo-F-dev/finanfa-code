import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentSocket } from "./hooks/useAgentSocket";
import { ChatMessageView } from "./components/ChatMessage";
import { ModelPicker } from "./components/ModelPicker";
import { PermissionModal } from "./components/PermissionModal";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";

export default function App() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>("");
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarRefreshToken, setSidebarRefreshToken] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((data: { models: string[]; defaultModel: string }) => {
        setModels(data.models);
        setModel((current) => current || data.defaultModel);
      })
      .catch(() => {
        setModels(["default"]);
        setModel("default");
      });
  }, []);

  const onTitled = useCallback(() => setSidebarRefreshToken((t) => t + 1), []);
  const { connected, timeline, busy, permissionRequest, status, sessionInfo, sendMessage, answerPermission, interrupt, reconnect, switchModel } =
    useAgentSocket(model || undefined, activeSessionId, onTitled);

  // A resumed session's model is authoritative (readonly on the CLI side —
  // mutable here, but only through switchModel) — keep the picker in sync
  // rather than showing whatever was last selected for a different chat.
  useEffect(() => {
    if (sessionInfo?.model && sessionInfo.model !== model) setModel(sessionInfo.model);
    if (sessionInfo?.id && sessionInfo.id !== activeSessionId) setActiveSessionId(sessionInfo.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionInfo?.model, sessionInfo?.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [timeline, busy]);

  function handleNewChat() {
    const wasAlreadyFresh = activeSessionId === undefined;
    setActiveSessionId(undefined);
    if (wasAlreadyFresh) reconnect();
  }

  function handleSend() {
    const text = input.trim();
    if (!text || busy.active) return;
    sendMessage(text);
    setInput("");
  }

  return (
    <div className="app-shell">
      <Sidebar
        activeSessionId={activeSessionId}
        refreshToken={sidebarRefreshToken}
        onSelect={setActiveSessionId}
        onNewChat={handleNewChat}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="app">
        <header className="topbar">
          <div className="brand">{sessionInfo?.title ?? "finanfa-code"}</div>
          <div className="topbar-right">
            {status && (
              <span className="cost-pill">
                {status.tokens.toLocaleString()} tok · ${status.costUsd.toFixed(4)}
              </span>
            )}
            <span className={`conn-dot ${connected ? "conn-on" : "conn-off"}`} title={connected ? "connected" : "disconnected"} />
          </div>
        </header>

        <main className="timeline" ref={scrollRef}>
          {timeline.length === 0 && (
            <div className="empty-state">
              <div className="empty-title">finanfa-code</div>
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
            <textarea
              className="composer-input"
              placeholder={connected ? "Message finanfa-code…" : "Connecting…"}
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
              <ModelPicker
                models={models.length > 0 ? models : [model]}
                model={model}
                onChange={(m) => {
                  setModel(m);
                  switchModel(m);
                }}
              />
              {busy.active ? (
                <button className="btn btn-stop" onClick={interrupt}>
                  Stop
                </button>
              ) : (
                <button className="btn btn-send" onClick={handleSend} disabled={!connected || !input.trim()}>
                  Send
                </button>
              )}
            </div>
          </div>
        </footer>
      </div>

      {permissionRequest && <PermissionModal request={permissionRequest} onAnswer={(answer) => answerPermission(permissionRequest.requestId, answer)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
