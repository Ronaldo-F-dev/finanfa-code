import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLanguage } from "../i18n/LanguageContext";

interface EffortTierInfo {
  id: string;
  label: string;
  description: string;
  model: string;
  ollamaModel?: string;
  installed: boolean;
}

/**
 * Real, reported preference: every new chat started on this project's
 * cloud default (Poolside) even for someone who mostly wants a small
 * local model — reaching that meant clicking Effort every single time. A
 * viewer-local preference (not synced across machines/browsers, same as
 * every other localStorage UI convenience here) lets one tier become the
 * one new chats start on automatically, without changing what anyone else
 * connecting to this server gets.
 */
export const DEFAULT_EFFORT_STORAGE_KEY = "finanfa.defaultEffortForNewChats";

export function getDefaultEffortPreference(): string | null {
  try {
    return localStorage.getItem(DEFAULT_EFFORT_STORAGE_KEY);
  } catch {
    return null;
  }
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
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [tiers, setTiers] = useState<EffortTierInfo[]>([]);
  const [defaultForNewChats, setDefaultForNewChats] = useState<string | null>(() => getDefaultEffortPreference());
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

  function toggleDefaultForNewChats(id: string, e: ReactMouseEvent) {
    e.stopPropagation();
    const next = defaultForNewChats === id ? null : id;
    setDefaultForNewChats(next);
    try {
      if (next) localStorage.setItem(DEFAULT_EFFORT_STORAGE_KEY, next);
      else localStorage.removeItem(DEFAULT_EFFORT_STORAGE_KEY);
    } catch {
      // Best-effort — a private window or blocked site data just means this
      // preference doesn't persist, not that the click itself should fail.
    }
  }

  const current = tiers.find((t) => t.id === currentEffort);

  return (
    <div className="effort-selector" ref={ref}>
      <button type="button" className="effort-selector-trigger" onClick={() => setOpen((o) => !o)}>
        {current ? t("effort.triggerWithLabel", { label: current.label }) : t("effort.trigger")}
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
                  {tier.ollamaModel && !tier.installed && <div className="effort-selector-warn">{t("effort.notInstalled")}</div>}
                </div>
                <button
                  type="button"
                  className={`effort-selector-default-star ${defaultForNewChats === tier.id ? "effort-selector-default-star-on" : ""}`}
                  title={defaultForNewChats === tier.id ? t("effort.starOn") : t("effort.starOff")}
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
          <div>{t("effort.modelNotInstalled", { model: needsDownload.ollamaModel })}</div>
          {pulling === needsDownload.ollamaModel ? (
            <div className="effort-download-progress">
              {t("effort.downloading")} {pullPercent !== null ? `${pullPercent}%` : ""}
            </div>
          ) : (
            <div className="effort-download-actions">
              <button type="button" onClick={() => pull(needsDownload.ollamaModel, needsDownload.level)}>
                {t("effort.downloadAndUse")}
              </button>
              <button type="button" onClick={onDismissNeedsDownload}>
                {t("effort.cancel")}
              </button>
            </div>
          )}
          {pullError && <div className="effort-download-error">{pullError}</div>}
        </div>
      )}
    </div>
  );
}
