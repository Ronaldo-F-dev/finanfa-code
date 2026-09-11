import { useEffect, useRef, useState } from "react";
import { useAgentBridge, type Attachment } from "./hooks/useAgentBridge";
import { ChatMessageView } from "./components/ChatMessage";
import { BusyIndicator } from "./components/BusyIndicator";
import { PermissionModal } from "./components/PermissionModal";
import { Composer } from "./components/Composer";
import { SessionHistory } from "./components/SessionHistory";

/**
 * Root component — the webview equivalent of web-client's App.tsx, minus
 * everything the plan marks out of scope for Phase 1 (sidebar, MCP/Memory/
 * Models/Tools/Settings panels, plan mode, /rewind, multi-root). One
 * session per workspace, no session switcher.
 */
export function App() {
  const {
    connected,
    timeline,
    busy,
    permissionRequest,
    sessionInfo,
    models,
    effortTiers,
    effortNeedsDownload,
    ollamaPull,
    sendMessage,
    answerPermission,
    interrupt,
    newChat,
    switchModel,
    setEffort,
    pullOllamaModel,
    dismissEffortNeedsDownload,
    requestApiKeyHelp,
    sessions,
    listSessions,
    switchSession,
    deleteSession,
  } = useAgentBridge();

  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<Attachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNeedingDownloadRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline, busy.active]);

  // Mirrors web-client's inline EventSource "done" handler: once the
  // requested Ollama model finishes downloading, automatically apply the
  // effort tier that was waiting on it instead of leaving the user to
  // reopen the selector and pick it again.
  useEffect(() => {
    if (effortNeedsDownload) wasNeedingDownloadRef.current = true;
    else if (wasNeedingDownloadRef.current && !ollamaPull) {
      wasNeedingDownloadRef.current = false;
    }
  }, [effortNeedsDownload, ollamaPull]);

  function handleSend() {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || busy.active) return;
    sendMessage(text || "(voir la pièce jointe)", pendingImages.length > 0 ? pendingImages : undefined);
    setInput("");
    setPendingImages([]);
  }

  function handleNewChat() {
    newChat();
    setInput("");
    setPendingImages([]);
  }

  const isLocalModel = models.some((m) => Boolean(m.baseUrl) && m.localModelId === sessionInfo?.model);

  return (
    // ".app" (not ".app-shell", which is a flex ROW meant to sit a sidebar
    // next to it in web-client) is the flex-COLUMN, height:100vh container
    // that stacks topbar/timeline/composer vertically — there is no
    // sidebar in this webview, so app-shell's row layout would otherwise
    // lay these three out side by side instead of stacked.
    <div className="app">
      <header className="topbar">
        <div className="brand">{sessionInfo?.title ?? "finanfa-code"}</div>
        <div className="topbar-right">
          <SessionHistory sessions={sessions} activeId={sessionInfo?.id} onRefresh={listSessions} onSwitch={switchSession} onDelete={deleteSession} />
          <button type="button" className="btn btn-ghost" onClick={handleNewChat} disabled={!connected} title="Démarrer une nouvelle conversation">
            + Nouvelle conversation
          </button>
          <span className={`conn-dot ${connected ? "conn-on" : "conn-off"}`} title={connected ? "Connecté" : "Déconnecté"} />
        </div>
      </header>

      <main className="timeline" ref={scrollRef}>
        {timeline.length === 0 && (
          <div className="empty-state">
            <div className="empty-title">Comment puis-je vous aider ?</div>
            <div className="empty-sub">Posez une question, ou demandez une modification dans ce projet.</div>
          </div>
        )}
        {timeline.map((item) => (
          <ChatMessageView key={item.id} item={item} />
        ))}
        {busy.active && <BusyIndicator label={busy.label} isLocalModel={isLocalModel} />}
      </main>

      <Composer
        input={input}
        setInput={setInput}
        onSend={handleSend}
        onInterrupt={interrupt}
        busy={busy.active}
        connected={connected}
        pendingImages={pendingImages}
        setPendingImages={setPendingImages}
        models={models}
        model={sessionInfo?.model ?? ""}
        onSwitchModel={switchModel}
        effortTiers={effortTiers}
        currentEffort={sessionInfo?.effort}
        effortNeedsDownload={effortNeedsDownload}
        ollamaPull={ollamaPull}
        onSetEffort={setEffort}
        onPullOllamaModel={pullOllamaModel}
        onDismissEffortNeedsDownload={dismissEffortNeedsDownload}
        onNeedsApiKey={requestApiKeyHelp}
      />

      {permissionRequest && <PermissionModal request={permissionRequest} onAnswer={(answer) => answerPermission(permissionRequest.requestId, answer)} />}
    </div>
  );
}
