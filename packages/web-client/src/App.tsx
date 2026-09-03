import { useEffect, useRef, useState } from "react";
import { useAgentSocket } from "./hooks/useAgentSocket";
import { ChatMessageView } from "./components/ChatMessage";
import { ModelSelector } from "./components/ModelSelector";
import { PermissionModal } from "./components/PermissionModal";

export default function App() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>("");
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((data: { models: string[]; defaultModel: string }) => {
        setModels(data.models);
        setModel(data.defaultModel);
      })
      .catch(() => {
        setModels(["default"]);
        setModel("default");
      });
  }, []);

  const { connected, timeline, busy, permissionRequest, status, sendMessage, answerPermission, interrupt, startNewChat } = useAgentSocket(
    model || undefined,
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [timeline, busy]);

  function handleSend() {
    const text = input.trim();
    if (!text || busy.active) return;
    sendMessage(text);
    setInput("");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">finanfa-code</div>
        <div className="topbar-right">
          {status && (
            <span className="cost-pill">
              {status.tokens.toLocaleString()} tok · ${status.costUsd.toFixed(4)}
            </span>
          )}
          <ModelSelector models={models.length > 0 ? models : [model]} model={model} onChange={setModel} disabled={timeline.length > 0} />
          <span className={`conn-dot ${connected ? "conn-on" : "conn-off"}`} title={connected ? "connected" : "disconnected"} />
          <button className="btn btn-ghost" onClick={startNewChat} title="New chat">
            New chat
          </button>
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
        {busy.active ? (
          <button className="btn btn-stop" onClick={interrupt}>
            Stop
          </button>
        ) : (
          <button className="btn btn-send" onClick={handleSend} disabled={!connected || !input.trim()}>
            Send
          </button>
        )}
      </footer>

      {permissionRequest && <PermissionModal request={permissionRequest} onAnswer={(answer) => answerPermission(permissionRequest.requestId, answer)} />}
    </div>
  );
}
