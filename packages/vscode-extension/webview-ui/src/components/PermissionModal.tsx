import type { PermissionRequest } from "../hooks/useAgentBridge";

// Port of web-client's PermissionModal.tsx, i18n stripped to hardcoded
// French. The prompt text itself comes from PermissionManager verbatim
// (server/engine-originated, English) — rendered as-is, not translated.
export function PermissionModal({ request, onAnswer }: { request: PermissionRequest; onAnswer: (answer: string) => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-title">Autorisation requise</div>
        <pre className="modal-prompt">{request.prompt.replace(/\n\[y\]es.*$/s, "").replace(/^finanfa-code /, "finanfa AI ").trim()}</pre>
        <div className="modal-actions">
          <button className="btn btn-deny" onClick={() => onAnswer("n")}>
            Refuser
          </button>
          <button className="btn btn-allow" onClick={() => onAnswer("y")}>
            Autoriser une fois
          </button>
          <button className="btn btn-allow-always" onClick={() => onAnswer("a")}>
            Toujours autoriser ceci
          </button>
          <button className="btn btn-allow-always" onClick={() => onAnswer("t")}>
            Toujours autoriser cet outil
          </button>
        </div>
      </div>
    </div>
  );
}
