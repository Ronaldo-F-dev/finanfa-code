import type { PermissionRequest } from "../hooks/useAgentSocket";
import { useLanguage } from "../i18n/LanguageContext";

export function PermissionModal({ request, onAnswer }: { request: PermissionRequest; onAnswer: (answer: string) => void }) {
  const { t } = useLanguage();
  // The prompt text from PermissionManager already contains the full
  // "finanfa-code wants to run ..." explanation plus a command/diff preview
  // — render it verbatim (monospace) rather than re-deriving a summary here.
  // Server-originated, English-only — not part of this UI-chrome-only i18n pass.
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-title">{t("permission.title")}</div>
        <pre className="modal-prompt">{request.prompt.replace(/\n\[y\]es.*$/s, "").replace(/^finanfa-code /, "finanfa AI ").trim()}</pre>
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
