import type { PermissionRequest } from "../hooks/useAgentSocket";

export function PermissionModal({ request, onAnswer }: { request: PermissionRequest; onAnswer: (answer: string) => void }) {
  // The prompt text from PermissionManager already contains the full
  // "finanfa-code wants to run ..." explanation plus a command/diff preview
  // — render it verbatim (monospace) rather than re-deriving a summary here.
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-title">Permission required</div>
        <pre className="modal-prompt">{request.prompt.replace(/\n\[y\]es.*$/s, "").replace(/^finanfa-code /, "finanfa AI ").trim()}</pre>
        <div className="modal-actions">
          <button className="btn btn-deny" onClick={() => onAnswer("n")}>
            Deny
          </button>
          <button className="btn btn-allow" onClick={() => onAnswer("y")}>
            Allow once
          </button>
          <button className="btn btn-allow-always" onClick={() => onAnswer("a")}>
            Always allow this
          </button>
          <button className="btn btn-allow-always" onClick={() => onAnswer("t")}>
            Always allow tool
          </button>
        </div>
      </div>
    </div>
  );
}
