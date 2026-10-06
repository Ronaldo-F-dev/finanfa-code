import type { ApprovalSettings } from "../hooks/useAgentSocket";
import { useLanguage } from "../i18n/LanguageContext";

const CATEGORY_ICON: Record<string, string> = { edits: "✏️", terminal: "⌨️", mcp: "🔌" };

/**
 * Which kinds of tool call the agent may run without asking each time. Everything else still prompts, and an
 * explicit permission rule or a blocking hook for a specific tool still wins over a switch here.
 */
export function ApprovalsPanel({
  approvals,
  connected,
  onClose,
  onSet,
}: {
  approvals: ApprovalSettings;
  connected: boolean;
  onClose: () => void;
  onSet: (category: string, enabled: boolean) => void;
}) {
  const { t } = useLanguage();
  const locked = approvals.forbidden || !connected;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-header-icon">✅</span>
          <span className="panel-header-title">{t("approvals.title")}</span>
          <button className="panel-header-close" onClick={onClose} aria-label={t("settings.close")}>
            ×
          </button>
        </div>
        <p className="settings-hint">{t("approvals.hint")}</p>
        {approvals.forbidden && <p className="approvals-forbidden">{t("approvals.forbidden")}</p>}

        <div className="mcp-list">
          {approvals.categories.map((category) => {
            const on = approvals.settings[category] === true;
            return (
              <div className="mcp-row approvals-row" key={category}>
                <div className="mcp-row-main">
                  <div>
                    <div className="mcp-name">
                      {CATEGORY_ICON[category] ?? "•"} {t(`approvals.${category}.name`)}
                    </div>
                    <div className="settings-hint approvals-desc">{t(`approvals.${category}.desc`)}</div>
                    {category === "terminal" && <div className="approvals-warning">{t("approvals.terminal.warning")}</div>}
                  </div>
                </div>
                <div className="mcp-row-actions">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={t(`approvals.${category}.name`)}
                    className={`approvals-switch${on ? " approvals-switch-on" : ""}`}
                    disabled={locked}
                    onClick={() => onSet(category, !on)}
                  >
                    <span className="approvals-switch-knob" />
                  </button>
                </div>
              </div>
            );
          })}
          {approvals.categories.length === 0 && <div className="sidebar-empty">{t("approvals.loading")}</div>}
        </div>
        <p className="settings-hint">{t("approvals.footer")}</p>
      </div>
    </div>
  );
}
