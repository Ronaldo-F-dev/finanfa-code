import { useMemo } from "react";
import { buildDiffRows } from "../diffRows";
import { useLanguage } from "../i18n/LanguageContext";
import type { FilePreview } from "../hooks/useAgentSocket";

/** A unified, line-numbered diff of the file a tool is about to change — what the approval is actually about. */
export function DiffView({ preview }: { preview: FilePreview }) {
  const { t } = useLanguage();
  const diff = useMemo(() => buildDiffRows(preview.before, preview.after), [preview.before, preview.after]);
  const isNew = preview.before === "";

  return (
    <div className="diff">
      <div className="diff-header">
        <span className="diff-path" title={preview.path}>
          {preview.path}
        </span>
        {isNew && <span className="diff-badge">{t("diff.newFile")}</span>}
        <span className="diff-counts">
          <span className="diff-count-add">+{diff.added}</span> <span className="diff-count-del">−{diff.removed}</span>
        </span>
      </div>
      <div className="diff-body" role="table" aria-label={t("diff.label", { path: preview.path })}>
        {diff.tooLarge && <div className="diff-note">{t("diff.tooLarge")}</div>}
        {!diff.tooLarge && diff.rows.length === 0 && <div className="diff-note">{t("diff.noChanges")}</div>}
        {diff.rows.map((row, i) =>
          row.kind === "gap" ? (
            <div key={i} className="diff-row diff-gap" role="row">
              {t("diff.hidden", { count: row.hidden })}
            </div>
          ) : (
            <div key={i} className={`diff-row diff-${row.kind}`} role="row">
              <span className="diff-no">{row.kind === "add" ? "" : row.oldNo}</span>
              <span className="diff-no">{row.kind === "del" ? "" : row.newNo}</span>
              <span className="diff-sign">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
              <span className="diff-text">{row.text || " "}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
