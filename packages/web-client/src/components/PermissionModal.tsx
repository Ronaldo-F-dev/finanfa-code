import type { PermissionRequest } from "../hooks/useAgentSocket";
import { useLanguage } from "../i18n/LanguageContext";
import { DiffView } from "./DiffView";

export function PermissionModal({ request, onAnswer }: { request: PermissionRequest; onAnswer: (answer: string) => void }) {
  const { t } = useLanguage();
  // The prompt text from PermissionManager already contains the full
  // "finanfa-code wants to run ..." explanation plus a command/diff preview
  // — render it verbatim (monospace) rather than re-deriving a summary here.
  // Server-originated, English-only — not part of this UI-chrome-only i18n pass.
  const text = request.prompt.replace(/\n\[y\]es.*$/s, "").trim().replace(/^finanfa-code /, "finanfa AI ");
  // With a structured before/after the diff replaces the tool's own text preview, which would only repeat it:
  // keep just the first line ("finanfa AI wants to run "edit_file": <summary>").
  const headline = request.filePreview ? text.split("\n")[0] : text;
  return (
    <div className="modal-backdrop">
      <div className={`modal${request.filePreview ? " modal-wide" : ""}`}>
        <div className="modal-title">{t("permission.title")}</div>
        <pre className={request.filePreview ? "modal-prompt modal-prompt-short" : "modal-prompt"}>{headline}</pre>
        {request.filePreview && <DiffView preview={request.filePreview} />}
        <div className="modal-actions">
          <button className="btn btn-deny" onClick={() => onAnswer("n")}>
            {t("permission.deny")}
          </button>
          <button className="btn btn-allow" onClick={() => onAnswer("y")}>
            {t("permission.allowOnce")}
          </button>
          <button className="btn btn-allow-always" onClick={() => onAnswer("a")}>
            {t("permission.alwaysAllowThis")}
          </button>
          <button className="btn btn-allow-always" onClick={() => onAnswer("t")}>
            {t("permission.alwaysAllowTool")}
          </button>
        </div>
      </div>
    </div>
  );
}
