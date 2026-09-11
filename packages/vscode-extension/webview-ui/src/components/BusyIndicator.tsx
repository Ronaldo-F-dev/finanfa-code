import { useEffect, useState } from "react";

// Port of web-client's BusyIndicator.tsx, i18n stripped to hardcoded
// French — see its own doc comment there for why the live elapsed-time
// counter and local-model hint exist (a slow-CPU local model's first
// response can look "frozen" without it).
export function BusyIndicator({ label, isLocalModel }: { label?: string; isLocalModel: boolean }) {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    setElapsedSec(0);
    const start = Date.now();
    const interval = setInterval(() => setElapsedSec(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  return (
    <div className="row row-log">
      <div className="log-line log-busy">
        <span className="spinner" /> {label ?? "en cours"}… <span className="busy-elapsed">{elapsedSec}s</span>
        {isLocalModel && elapsedSec >= 5 && (
          <div className="busy-local-hint">
            Modèle local — le traitement du prompt peut prendre une à deux minutes sur une machine sans GPU, avant même le début de la
            génération.
          </div>
        )}
      </div>
    </div>
  );
}
