import { useEffect, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";

/**
 * Real, reported UX confusion: a local model's initial prompt processing
 * (this project's own system prompt, before any conversation) can take
 * well over a minute on CPU-only hardware — measured ~148s in one real
 * test — with nothing on screen but a static "thinking…" spinner. By the
 * time the reply's tokens actually stream in, they arrive fast enough
 * relative to that wait that it reads as "the model generated everything
 * before the UI showed anything", even though token-by-token streaming
 * itself is working correctly the whole time. A live elapsed-time counter
 * proves the app is still alive, and a hint after a few seconds explains
 * *why* a local model in particular can take this long.
 */
export function BusyIndicator({ label, isLocalModel }: { label?: string; isLocalModel: boolean }) {
  const { t } = useLanguage();
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    setElapsedSec(0);
    const start = Date.now();
    const interval = setInterval(() => setElapsedSec(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(interval);
    // Restarts the counter whenever the label changes (e.g. "thinking" ->
    // a tool-call label) — each phase gets its own fresh timer instead of
    // one counter spanning unrelated phases.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  return (
    <div className="row row-log">
      <div className="log-line log-busy">
        <span className="spinner" /> {label ?? t("busy.working")}… <span className="busy-elapsed">{elapsedSec}s</span>
        {isLocalModel && elapsedSec >= 5 && <div className="busy-local-hint">{t("busy.localModelHint")}</div>}
      </div>
    </div>
  );
}
