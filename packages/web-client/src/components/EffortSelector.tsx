import { useEffect, useRef, useState } from "react";

interface EffortTierInfo {
  id: string;
  label: string;
  description: string;
  model: string;
  ollamaModel?: string;
  installed: boolean;
}

/**
 * Low/Medium/High shortcut past manually picking a model, remembering to
 * cap max_tokens, and remembering to strip most tools every time a small
 * local model is chosen — one click picks all three together (see
 * effort-tiers.ts). Downloads the tier's Ollama model inline (real SSE
 * progress) when it isn't installed yet, instead of just failing.
 */
export function EffortSelector({
  currentEffort,
  needsDownload,
  onSelect,
  onDismissNeedsDownload,
}: {
  currentEffort?: string;
  needsDownload: { level: string; ollamaModel: string } | null;
  onSelect: (level: string) => void;
  onDismissNeedsDownload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tiers, setTiers] = useState<EffortTierInfo[]>([]);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  function refreshTiers() {
    fetch("/api/effort-tiers")
      .then((r) => r.json())
      .then((d: { tiers: EffortTierInfo[] }) => setTiers(d.tiers))
      .catch(() => setTiers([]));
  }

  useEffect(() => {
    refreshTiers();
  }, []);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function pull(name: string, thenSelectLevel: string) {
    setPulling(name);
    setPullPercent(0);
    setPullError(null);
    const es = new EventSource(`/api/ollama-models/pull?name=${encodeURIComponent(name)}`);
    es.addEventListener("progress", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { completed?: number; total?: number };
      if (p.total) setPullPercent(Math.round(((p.completed ?? 0) / p.total) * 100));
    });
    es.addEventListener("done", () => {
      es.close();
      setPulling(null);
      refreshTiers();
      onDismissNeedsDownload();
      onSelect(thenSelectLevel);
    });
    es.addEventListener("error", (e) => {
      const raw = (e as MessageEvent).data;
      if (raw) setPullError(JSON.parse(raw) as string);
      es.close();
      setPulling(null);
    });
  }

  const current = tiers.find((t) => t.id === currentEffort);

  return (
    <div className="effort-selector" ref={ref}>
      <button type="button" className="effort-selector-trigger" onClick={() => setOpen((o) => !o)}>
        {current ? `Effort: ${current.label}` : "Effort"}
      </button>
      {open && (
        <div className="effort-selector-menu">
          {tiers.map((t) => (
            <button
              key={t.id}
              type="button"
              className="effort-selector-item"
              onClick={() => {
                setOpen(false);
                onSelect(t.id);
              }}
            >
              <div>
                <div className="effort-selector-name">
                  {t.label} {t.id === currentEffort && <span className="effort-selector-check">✓</span>}
                </div>
                <div className="effort-selector-blurb">{t.description}</div>
                {t.ollamaModel && !t.installed && <div className="effort-selector-warn">modèle non installé — sera téléchargé au premier choix</div>}
              </div>
            </button>
          ))}
        </div>
      )}

      {needsDownload && (
        <div className="effort-download-prompt">
          <div>
            Le modèle <strong>{needsDownload.ollamaModel}</strong> n'est pas installé.
          </div>
          {pulling === needsDownload.ollamaModel ? (
            <div className="effort-download-progress">Téléchargement… {pullPercent !== null ? `${pullPercent}%` : ""}</div>
          ) : (
            <div className="effort-download-actions">
              <button type="button" onClick={() => pull(needsDownload.ollamaModel, needsDownload.level)}>
                Télécharger et activer
              </button>
              <button type="button" onClick={onDismissNeedsDownload}>
                Annuler
              </button>
            </div>
          )}
          {pullError && <div className="effort-download-error">{pullError}</div>}
        </div>
      )}
    </div>
  );
}
