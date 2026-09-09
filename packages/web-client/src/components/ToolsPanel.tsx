import { useEffect, useMemo, useState } from "react";
import type { ToolStatus } from "../hooks/useAgentSocket";
import { useLanguage } from "../i18n/LanguageContext";

const RISK_ICON: Record<string, string> = { safe: "🟢", ask: "🟡", dangerous: "🔴" };
const RISK_ORDER = ["safe", "ask", "dangerous"];
const RISK_LABEL_KEYS: Record<string, string> = { safe: "tools.riskSafe", ask: "tools.riskAsk", dangerous: "tools.riskDangerous" };

/**
 * Manage the full tool list from the browser — the CLI's own /tools has
 * had this since the start, but the web UI only ever exposed two
 * hardcoded toggles (web search, image gen). Direct, immediate fix for a
 * real problem: a small-context local model (4k-16k tokens) overflows on
 * this project's system prompt + full tool list before a single user
 * message is even added — disabling most tools here is what actually
 * gets that usable, not something that needed a new tool/model feature.
 *
 * Grouped by risk level and collapsed by default — a flat list of 100+
 * tools was unusable at this project's real scale (129 tools in this
 * environment). A search box auto-expands whichever groups still have a
 * match, so it stays fast to find one specific tool without giving up
 * the overview counts collapsing provides.
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
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    onRefresh();
    // Fetch once when the panel opens — no polling needed, every toggle
    // (from here or another connection to this session) pushes a fresh
    // tools_status on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enabledCount = tools.filter((tl) => tl.enabled).length;
  const q = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const byRisk = new Map<string, ToolStatus[]>();
    for (const risk of RISK_ORDER) byRisk.set(risk, []);
    for (const tl of tools) {
      if (q && !tl.name.toLowerCase().includes(q)) continue;
      (byRisk.get(tl.riskLevel) ?? byRisk.set(tl.riskLevel, []).get(tl.riskLevel)!).push(tl);
    }
    return byRisk;
  }, [tools, q]);

  function toggleGroup(risk: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(risk)) next.delete(risk);
      else next.add(risk);
      return next;
    });
  }

  function setGroupEnabled(list: ToolStatus[], enabled: boolean) {
    for (const tl of list) if (tl.enabled !== enabled) onToggle(tl.name, enabled);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-header-icon">🧰</span>
          <span className="panel-header-title">{t("tools.title")}</span>
          <button className="panel-header-close" onClick={onClose} aria-label={t("settings.close")}>
            ×
          </button>
        </div>
        <p className="settings-hint">
          {tools.length > 0 ? t("tools.hintCount", { enabled: enabledCount, total: tools.length }) : t("tools.loading")} {t("tools.hintExplain")}
        </p>

        <input
          className="panel-search"
          type="text"
          placeholder={t("tools.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="mcp-list tools-panel-list">
          {RISK_ORDER.map((risk) => {
            const list = groups.get(risk) ?? [];
            if (list.length === 0) return null;
            const isOpen = expanded.has(risk) || q.length > 0;
            return (
              <div key={risk} className="tool-group">
                <div className="tool-group-header">
                  <button type="button" className="tool-group-toggle" onClick={() => toggleGroup(risk)}>
                    <span className={`tool-group-chevron ${isOpen ? "tool-group-chevron-open" : ""}`}>▸</span>
                    <span className="tool-group-icon">{RISK_ICON[risk]}</span>
                    <span className="tool-group-label">{t(RISK_LABEL_KEYS[risk] ?? risk)}</span>
                    <span className="tool-group-count">
                      {list.filter((tl) => tl.enabled).length}/{list.length}
                    </span>
                  </button>
                  <button type="button" className="tool-group-bulk" onClick={() => setGroupEnabled(list, true)}>
                    {t("tools.enableAll")}
                  </button>
                  <button type="button" className="tool-group-bulk" onClick={() => setGroupEnabled(list, false)}>
                    {t("tools.disableAll")}
                  </button>
                </div>
                {isOpen && (
                  <div className="tool-group-body">
                    {list.map((tl) => (
                      <div className="mcp-row" key={tl.name}>
                        <div className="mcp-row-main">
                          <div>
                            <div className="mcp-name">{tl.name}</div>
                          </div>
                        </div>
                        <div className="mcp-row-actions">
                          <button className="btn btn-ghost" onClick={() => onToggle(tl.name, !tl.enabled)}>
                            {tl.enabled ? t("tools.disable") : t("tools.enable")}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {tools.length === 0 && <div className="sidebar-empty">{t("tools.loadingTools")}</div>}
          {tools.length > 0 && [...groups.values()].every((l) => l.length === 0) && (
            <div className="sidebar-empty">{t("tools.noMatch", { query })}</div>
          )}
        </div>
      </div>
    </div>
  );
}
