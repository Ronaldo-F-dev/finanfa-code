import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { EffortTierInfo, OllamaPullState } from "../hooks/useAgentBridge";

/** Same viewer-local "start new chats on this tier" preference as web-client's EffortSelector — see its own doc comment there. */
export const DEFAULT_EFFORT_STORAGE_KEY = "finanfa.defaultEffortForNewChats";

export function getDefaultEffortPreference(): string | null {
  try {
    return localStorage.getItem(DEFAULT_EFFORT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Port of web-client's EffortSelector.tsx. Two transport-coupled bits
 * adapted (everything else — including the download-prompt UI and the
 * per-viewer "default for new chats" star — is unchanged):
 *  - `tiers` is now a prop (posted once by the host as an `effort_tiers`
 *    message) instead of `fetch("/api/effort-tiers")` — there's no HTTP
 *    server in the extension to fetch from.
 *  - the download flow is driven by `pullState`/`onPull` (postMessage to
 *    the host, which runs the real Ollama pull and streams progress back
 *    as ollama_pull_progress/done/error messages via useAgentBridge)
 *    instead of `new EventSource(...)`.
 */
export function EffortSelector({
  currentEffort,
  tiers,
  needsDownload,
  pullState,
  onSelect,
  onPull,
  onDismissNeedsDownload,
}: {
  currentEffort?: string;
  tiers: EffortTierInfo[];
  needsDownload: { level: string; ollamaModel: string } | null;
  pullState: OllamaPullState | null;
  onSelect: (level: string) => void;
  onPull: (ollamaModel: string) => void;
  onDismissNeedsDownload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [defaultForNewChats, setDefaultForNewChats] = useState<string | null>(() => getDefaultEffortPreference());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function toggleDefaultForNewChats(id: string, e: ReactMouseEvent) {
    e.stopPropagation();
    const next = defaultForNewChats === id ? null : id;
    setDefaultForNewChats(next);
    try {
      if (next) localStorage.setItem(DEFAULT_EFFORT_STORAGE_KEY, next);
      else localStorage.removeItem(DEFAULT_EFFORT_STORAGE_KEY);
    } catch {
      // Best-effort — a blocked/cleared storage just means the preference
      // doesn't persist, not that the click itself should fail.
    }
  }

  const current = tiers.find((t) => t.id === currentEffort);
  const pulling = needsDownload && pullState?.name === needsDownload.ollamaModel;

  return (
    <div className="effort-selector" ref={ref}>
      <button type="button" className="effort-selector-trigger" onClick={() => setOpen((o) => !o)}>
        {current ? `Effort : ${current.label}` : "Effort"}
      </button>
      {open && (
        <div className="effort-selector-menu">
          {tiers.map((tier) => (
            <button
              key={tier.id}
              type="button"
              className="effort-selector-item"
              onClick={() => {
                setOpen(false);
                onSelect(tier.id);
              }}
            >
              <div className="effort-selector-row">
                <div>
                  <div className="effort-selector-name">
                    {tier.label} {tier.id === currentEffort && <span className="effort-selector-check">✓</span>}
                  </div>
                  <div className="effort-selector-blurb">{tier.description}</div>
                  {tier.ollamaModel && !tier.installed && (
                    <div className="effort-selector-warn">modèle non installé — sera téléchargé au premier choix</div>
                  )}
                </div>
                <button
                  type="button"
                  className={`effort-selector-default-star ${defaultForNewChats === tier.id ? "effort-selector-default-star-on" : ""}`}
                  title={
                    defaultForNewChats === tier.id
                      ? "Ne plus utiliser par défaut pour les nouveaux chats"
                      : "Utiliser par défaut pour les nouveaux chats"
                  }
                  onClick={(e) => toggleDefaultForNewChats(tier.id, e)}
                >
                  {defaultForNewChats === tier.id ? "★" : "☆"}
                </button>
              </div>
            </button>
          ))}
        </div>
      )}

      {needsDownload && (
        <div className="effort-download-prompt">
          <div>Le modèle {needsDownload.ollamaModel} n'est pas installé.</div>
          {pulling ? (
            <div className="effort-download-progress">Téléchargement… {pullState?.percent !== null ? `${pullState?.percent}%` : ""}</div>
          ) : (
            <div className="effort-download-actions">
              <button type="button" onClick={() => onPull(needsDownload.ollamaModel)}>
                Télécharger et activer
              </button>
              <button type="button" onClick={onDismissNeedsDownload}>
                Annuler
              </button>
            </div>
          )}
          {pullState?.error && <div className="effort-download-error">{pullState.error}</div>}
        </div>
      )}
    </div>
  );
}
