import type { McpServerStatus } from "../hooks/useAgentSocket";
import { useLanguage } from "../i18n/LanguageContext";
import { BrandLogo } from "./BrandLogo";
import { resolveBrand } from "../brands";
import { Icon } from "./Icon";

export function McpPanel({
  servers,
  loaded,
  onClose,
  onConnect,
  onToggle,
  onReload,
}: {
  servers: McpServerStatus[];
  loaded: boolean;
  onClose: () => void;
  onConnect: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
  onReload: () => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-header-icon">
            <Icon name="connectors" size={20} />
          </span>
          <span className="panel-header-title">{t("mcp.title")}</span>
          <button className="panel-header-close" onClick={onClose} aria-label={t("settings.close")}>
            ×
          </button>
        </div>
        <p className="settings-hint">{t("mcp.hint")}</p>

        {servers.length === 0 && <div className="sidebar-empty">{loaded ? t("mcp.noneAvailable") : t("mcp.loading")}</div>}

        <div className="mcp-list">
          {servers.map((s) => (
            <div className="mcp-row" key={s.name}>
              <div className="mcp-row-main">
                <BrandLogo id={s.name} />
                <div className="mcp-text">
                  <div className="mcp-name" title={s.name}>
                    <span className={`mcp-dot ${s.connected ? "mcp-dot-on" : s.needsAuth ? "mcp-dot-auth" : "mcp-dot-off"}`} aria-hidden="true" />
                    {resolveBrand(s.name).label}
                  </div>
                  <div className="mcp-meta">
                    {s.transport}
                    {s.connected && s.disabled ? ` · ${t("mcp.disabled")}` : ""}
                    {s.needsAuth ? ` · ${t("mcp.needsAuth")}` : ""}
                    {!s.connected && !s.inProject ? ` · ${t("mcp.notAddedYet")}` : ""}
                  </div>
                </div>
              </div>
              <div className="mcp-row-actions">
                {!s.connected && (
                  <button className="btn btn-allow" onClick={() => onConnect(s.name)}>
                    {t("mcp.add")}
                  </button>
                )}
                {s.connected && (
                  <button className="btn btn-ghost" onClick={() => onToggle(s.name, s.disabled)}>
                    {s.disabled ? t("mcp.enable") : t("mcp.disable")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onReload}>
            {t("mcp.reloadTools")}
          </button>
        </div>
      </div>
    </div>
  );
}
