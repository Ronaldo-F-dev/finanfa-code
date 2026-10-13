import { useState } from "react";
import type { ToolStatus } from "../hooks/useAgentBridge";

const RISK_ORDER = ["safe", "ask", "dangerous"];
const RISK_LABEL: Record<string, string> = { safe: "Sûr", ask: "Confirmation", dangerous: "Dangereux" };
const RISK_DOT: Record<string, string> = { safe: "mcp-dot-on", ask: "mcp-dot-auth", dangerous: "tool-dot-danger" };

/**
 * The webview's own Tools panel — the port of web-client's ToolsPanel.tsx
 * that useAgentBridge.ts's header comment used to list as dropped. Same
 * grouped-by-risk layout and CSS classes (the styles were already ported
 * along with the rest of the web UI), but hardcoded French strings like the
 * rest of this webview, and no toolLabel()/Icon (neither exists here), so
 * rows show the raw tool name.
 *
 * Why this matters at this project's own scale: the system prompt plus the
 * full tool list runs to tens of thousands of tokens before the first user
 * message — for a small-context local model, disabling most tools here is
 * what makes it usable at all (same reasoning as the web panel's docstring).
 */
export function ToolsPanel({
  tools,
  onClose,
  onToggle,
}: {
  tools: ToolStatus[];
  onClose: () => void;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);

  const q = query.trim().toLowerCase();
  const visible = tools.filter((tool) => !q || tool.name.toLowerCase().includes(q));
  const enabledCount = tools.filter((tool) => tool.enabled).length;

  function toggleGroup(risk: string) {
    setExpanded((current) => (current.includes(risk) ? current.filter((r) => r !== risk) : [...current, risk]));
  }

  function setGroupEnabled(list: ToolStatus[], enabled: boolean) {
    for (const tool of list) if (tool.enabled !== enabled) onToggle(tool.name, enabled);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-modal" onClick={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-header-title">Outils</span>
          <button className="panel-header-close" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </div>
        <p className="settings-hint">
          {tools.length > 0 ? `${enabledCount} sur ${tools.length} activés.` : "Chargement…"} Désactiver des outils réduit ce qui est envoyé au
          modèle à chaque tour, utile pour un modèle local à petit contexte qui déborde autrement avant même l'envoi d'un seul message.
        </p>

        <input
          className="panel-search"
          type="text"
          placeholder="Rechercher un outil…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="mcp-list tools-panel-list">
          {RISK_ORDER.map((risk) => {
            const list = visible.filter((tool) => tool.riskLevel === risk);
            if (list.length === 0) return null;
            const isOpen = expanded.includes(risk) || q.length > 0;
            return (
              <div key={risk} className="tool-group">
                <div className="tool-group-header">
                  <button type="button" className="tool-group-toggle" onClick={() => toggleGroup(risk)}>
                    <span className={`tool-group-chevron ${isOpen ? "tool-group-chevron-open" : ""}`}>▸</span>
                    <span className={`mcp-dot ${RISK_DOT[risk]}`} />
                    <span className="tool-group-label">{RISK_LABEL[risk] ?? risk}</span>
                    <span className="tool-group-count">
                      {list.filter((tool) => tool.enabled).length}/{list.length}
                    </span>
                  </button>
                  <button type="button" className="tool-group-bulk" onClick={() => setGroupEnabled(list, true)}>
                    Tout activer
                  </button>
                  <button type="button" className="tool-group-bulk" onClick={() => setGroupEnabled(list, false)}>
                    Tout désactiver
                  </button>
                </div>
                {isOpen && (
                  <div className="tool-group-body">
                    {list.map((tool) => (
                      <div className="mcp-row" key={tool.name}>
                        <div className="mcp-row-main">
                          <div className="mcp-name" title={tool.name}>
                            {tool.name}
                          </div>
                        </div>
                        <div className="mcp-row-actions">
                          <button className="btn btn-ghost" onClick={() => onToggle(tool.name, !tool.enabled)}>
                            {tool.enabled ? "Désactiver" : "Activer"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {tools.length === 0 && <div className="sidebar-empty">Chargement des outils…</div>}
          {tools.length > 0 && visible.length === 0 && <div className="sidebar-empty">Aucun outil ne correspond à "{query}".</div>}
        </div>
      </div>
    </div>
  );
}
