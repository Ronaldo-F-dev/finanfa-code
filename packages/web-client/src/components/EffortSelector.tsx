import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLanguage } from "../i18n/LanguageContext";

/** How much the current model thinks; applied to every message from now on. See core/effort-level.ts. */
export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value as string);
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
 * Low / Medium / High: how much the current model thinks before it answers, like Claude Code's /effort. It changes
 * neither the model nor the tools. The model download prompt below only serves the specialist presets (the legal
 * model), which are picked from the model picker.
 */
export function EffortSelector({
  currentLevel,
  needsDownload,
  onSelect,
  onSelectPreset,
  onDismissNeedsDownload,
}: {
  currentLevel?: string;
  needsDownload: { level: string; ollamaModel: string } | null;
  onSelect: (level: EffortLevel) => void;
  /** Applies a specialist preset once its model has been downloaded. */
  onSelectPreset: (level: string) => void;
  onDismissNeedsDownload: () => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [defaultForNewChats, setDefaultForNewChats] = useState<string | null>(() => getDefaultEffortPreference());
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

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
      onDismissNeedsDownload();
      onSelectPreset(thenSelectLevel);
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

  const levelKnown = isEffortLevel(currentLevel);

  return (
    <div className="effort-selector" ref={ref}>
      <button type="button" className="effort-selector-trigger" onClick={() => setOpen((o) => !o)}>
        {levelKnown ? t("effort.triggerWithLabel", { label: t(`effort.${currentLevel}`) }) : t("effort.trigger")}
      </button>
      {open && (
        <div className="effort-selector-menu">
          {EFFORT_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className="effort-selector-item"
              onClick={() => {
                setOpen(false);
                onSelect(level);
              }}
            >
              <div className="effort-selector-row">
                <div>
                  <div className="effort-selector-name">
                    {t(`effort.${level}`)} {level === currentLevel && <span className="effort-selector-check">✓</span>}
                  </div>
                  <div className="effort-selector-blurb">{t(`effort.${level}.desc`)}</div>
                </div>
                <button
                  type="button"
                  className={`effort-selector-default-star ${defaultForNewChats === level ? "effort-selector-default-star-on" : ""}`}
                  title={defaultForNewChats === level ? t("effort.starOn") : t("effort.starOff")}
                  onClick={(e) => toggleDefaultForNewChats(level, e)}
                >
                  {defaultForNewChats === level ? "★" : "☆"}
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
