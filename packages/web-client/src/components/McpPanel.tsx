import type { McpServerStatus } from "../hooks/useAgentSocket";

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
      <div className="modal mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Connectors</div>
        <p className="settings-hint">
          Adding a connector saves it to this project's <code>.finanfa-code/mcp.json</code>. Connecting to a remote one may open a browser tab on the
          machine running the server for OAuth.
        </p>

        {servers.length === 0 && <div className="sidebar-empty">{loaded ? "No connectors available." : "Loading connectors…"}</div>}

        <div className="mcp-list">
          {servers.map((s) => (
            <div className="mcp-row" key={s.name}>
              <div className="mcp-row-main">
                <span className={`mcp-dot ${s.connected ? "mcp-dot-on" : s.needsAuth ? "mcp-dot-auth" : "mcp-dot-off"}`} />
                <div>
                  <div className="mcp-name">{s.name}</div>
                  <div className="mcp-meta">
                    {s.transport}
                    {s.connected && s.disabled ? " · disabled" : ""}
                    {s.needsAuth ? " · needs authorization" : ""}
                    {!s.connected && !s.inProject ? " · not added yet" : ""}
                  </div>
                </div>
              </div>
              <div className="mcp-row-actions">
                {!s.connected && (
                  <button className="btn btn-allow" onClick={() => onConnect(s.name)}>
                    + Add
                  </button>
                )}
                {s.connected && (
                  <button className="btn btn-ghost" onClick={() => onToggle(s.name, s.disabled)}>
                    {s.disabled ? "Enable" : "Disable"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onReload}>
            Reload tools
          </button>
          <button className="btn btn-allow" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
