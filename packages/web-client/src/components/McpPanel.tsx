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
        <div className="modal-title">MCP servers</div>
        <p className="settings-hint">
          Configured in <code>.finanfa-code/mcp.json</code>. Connecting to a remote server may open a browser tab on the machine running the server for
          OAuth.
        </p>

        {servers.length === 0 && (
          <div className="sidebar-empty">{loaded ? "No MCP servers configured for this project." : "Connecting to configured servers…"}</div>
        )}

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
                  </div>
                </div>
              </div>
              <div className="mcp-row-actions">
                {!s.connected && (
                  <button className="btn btn-ghost" onClick={() => onConnect(s.name)}>
                    Connect
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
