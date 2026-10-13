import type { McpServerStatus } from "../hooks/useAgentBridge";

/**
 * The webview's own MCP panel — port of web-client's McpPanel.tsx, minus
 * everything with no counterpart here: no BrandLogo/resolveBrand (server
 * names show raw) and no Icon. Strings are the web client's own French
 * wording, hardcoded like the rest of this webview.
 *
 * A connector that isn't connected yet shows the same "+ Ajouter" button
 * whether it's a configured server whose connect failed or a raw catalog
 * entry: connecting is what adds it to .finanfa-code/mcp.json, and the
 * panel cannot tell those two cases apart in any way that would help.
 */
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
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-modal" onClick={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-header-title">Connecteurs</span>
          <button className="panel-header-close" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </div>
        <p className="settings-hint">
          Ajouter un connecteur l'enregistre dans le .finanfa-code/mcp.json de ce projet. Se connecter à un connecteur distant peut ouvrir un onglet
          de navigateur sur la machine qui exécute le serveur, pour l'OAuth.
        </p>

        {servers.length === 0 && <div className="sidebar-empty">{loaded ? "Aucun connecteur disponible." : "Chargement des connecteurs…"}</div>}

        <div className="mcp-list">
          {servers.map((server) => (
            <div className="mcp-row" key={server.name}>
              <div className="mcp-row-main">
                <div className="mcp-text">
                  <div className="mcp-name" title={server.name}>
                    <span className={`mcp-dot ${server.connected ? "mcp-dot-on" : server.needsAuth ? "mcp-dot-auth" : "mcp-dot-off"}`} aria-hidden="true" />
                    {server.name}
                  </div>
                  <div className="mcp-meta">
                    {server.transport}
                    {server.connected && server.disabled ? " · désactivé" : ""}
                    {server.needsAuth ? " · autorisation requise" : ""}
                    {!server.connected && !server.inProject ? " · pas encore ajouté" : ""}
                  </div>
                </div>
              </div>
              <div className="mcp-row-actions">
                {!server.connected && (
                  <button className="btn btn-allow" onClick={() => onConnect(server.name)}>
                    + Ajouter
                  </button>
                )}
                {server.connected && (
                  <button className="btn btn-ghost" onClick={() => onToggle(server.name, server.disabled)}>
                    {server.disabled ? "Activer" : "Désactiver"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onReload}>
            Recharger les outils
          </button>
        </div>
      </div>
    </div>
  );
}
