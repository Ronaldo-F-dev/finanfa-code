import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../hooks/useAgentBridge";

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * No multi-session sidebar in this phase (see the plan's out-of-scope
 * list) — a small on-demand dropdown is the minimal way to see and reopen
 * past conversations for this workspace, reusing the .sidebar-item/
 * .model-picker-menu styling already present in the ported index.css
 * (written for web-client's real sidebar, otherwise unused here).
 */
export function SessionHistory({
  sessions,
  activeId,
  onRefresh,
  onSwitch,
  onDelete,
}: {
  sessions: SessionSummary[];
  activeId?: string;
  onRefresh: () => void;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div className="model-picker" ref={ref}>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) onRefresh();
        }}
        title="Historique des conversations"
      >
        Historique
      </button>
      {open && (
        /* .model-picker-menu is written for a composer trigger (opens upward,
           bottom: calc(100% + 8px)) — this button lives in the topbar
           instead, at the very top of the panel, so opening upward rendered
           the menu entirely off-screen (looked like clicking did nothing).
           Override to open downward here. */
        <div className="model-picker-menu" style={{ minWidth: 280, bottom: "auto", top: "calc(100% + 8px)" }}>
          {sessions.length === 0 && <div className="sidebar-empty">Aucune conversation enregistrée pour ce dossier.</div>}
          {sessions.map((s) => (
            <div key={s.id} className={`sidebar-item ${s.id === activeId ? "sidebar-item-active" : ""}`}>
              <button
                type="button"
                className="model-picker-item"
                style={{ flex: 1, textAlign: "left" }}
                onClick={() => {
                  setOpen(false);
                  onSwitch(s.id);
                }}
              >
                <div>
                  <div className="model-picker-name">{s.title ?? "Sans titre"}</div>
                  <div className="model-picker-blurb">{formatWhen(s.mtime)}</div>
                </div>
              </button>
              <button type="button" className="sidebar-item-delete" title="Supprimer" onClick={() => onDelete(s.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
