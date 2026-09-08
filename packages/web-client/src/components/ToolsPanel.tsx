import { useEffect } from "react";
import type { ToolStatus } from "../hooks/useAgentSocket";

const RISK_ICON: Record<string, string> = { safe: "🟢", ask: "🟡", dangerous: "🔴" };

/**
 * Manage the full tool list from the browser — the CLI's own /tools has
 * had this since the start, but the web UI only ever exposed two
 * hardcoded toggles (web search, image gen). Direct, immediate fix for a
 * real problem: a small-context local model (4k-16k tokens) overflows on
 * this project's system prompt + full 90+-tool list before a single user
 * message is even added — disabling most tools here is what actually
 * gets that usable, not something that needed a new tool/model feature.
 */
export function ToolsPanel({
  tools,
  onClose,
  onToggle,
  onRefresh,
}: {
  tools: ToolStatus[];
  onClose: () => void;
  onToggle: (name: string, enabled: boolean) => void;
  onRefresh: () => void;
}) {
  useEffect(() => {
    onRefresh();
    // Fetch once when the panel opens — no polling needed, every toggle
    // (from here or another connection to this session) pushes a fresh
    // tools_status on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enabledCount = tools.filter((t) => t.enabled).length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Tools</div>
        <p className="settings-hint">
          {tools.length > 0 ? `${enabledCount} of ${tools.length} enabled.` : "Loading…"} Disabling tools shrinks what's sent to the model on every
          turn — useful for a small-context local model that otherwise overflows before a single message is even sent.
        </p>

        <div className="mcp-list tools-panel-list">
          {tools.map((t) => (
            <div className="mcp-row" key={t.name}>
              <div className="mcp-row-main">
                <span className="mcp-icon">{RISK_ICON[t.riskLevel] ?? "⚪"}</span>
                <div>
                  <div className="mcp-name">{t.name}</div>
                  <div className="mcp-meta">{t.riskLevel}</div>
                </div>
              </div>
              <div className="mcp-row-actions">
                <button className="btn btn-ghost" onClick={() => onToggle(t.name, !t.enabled)}>
                  {t.enabled ? "Disable" : "Enable"}
                </button>
              </div>
            </div>
          ))}
          {tools.length === 0 && <div className="sidebar-empty">Loading tools…</div>}
        </div>

        <div className="modal-actions">
          <button className="btn btn-allow" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
