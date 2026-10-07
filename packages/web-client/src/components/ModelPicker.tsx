import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";
import { groupModels } from "../modelGroups";

export interface ModelOption {
  id: string;
  family: string;
  configured: boolean;
  /** Set for a detected local runtime (Ollama/LM Studio/...) — talk to this exact endpoint instead of whatever's saved in Settings. */
  baseUrl?: string;
  /** The real model string the provider expects — only differs from `id` for a local model, where `id` is a display label ("Ollama: llama3.1:8b") for the picker. */
  localModelId?: string;
  /** Set for a cloud provider's model (DeepSeek, Grok, Gemini): shown under the name. */
  provider?: string;
  /** Config-defined local model, and whether its server is running right now. */
  local?: boolean;
  running?: boolean;
}

const BLURB_KEYS: Record<string, string> = {
  "claude-opus-5": "modelPicker.blurbOpus",
  "claude-sonnet-5": "modelPicker.blurbSonnet",
  "claude-haiku-4-5-20251001": "modelPicker.blurbHaiku",
};

export function ModelPicker({
  models,
  model,
  onChange,
  onNeedsKey,
  currentEffort,
  onSelectLegal,
}: {
  models: ModelOption[];
  model: string;
  onChange: (model: string, family: string, baseUrl?: string) => void;
  onNeedsKey: () => void;
  currentEffort?: string;
  /** Switches to the "legal" preset (SaulLM, no tools); the server asks for the download itself when the model is missing. */
  onSelectLegal: () => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The specialist (legal) model is a local download: it is only offered when it is already on this machine.
  const [legalInstalled, setLegalInstalled] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => groupModels(models, query), [models, query]);
  const legalAvailable = legalInstalled || currentEffort === "legal";
  const showLegal = legalAvailable && (!query.trim() || `${t("modelPicker.legal")} legal juridique`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (open) {
      searchRef.current?.focus();
      fetch("/api/effort-tiers")
        .then((r) => r.json())
        .then((d: { tiers: { id: string; installed: boolean }[] }) => setLegalInstalled(Boolean(d.tiers.find((tier) => tier.id === "legal")?.installed)))
        .catch(() => setLegalInstalled(false));
    } else setQuery("");
  }, [open]);

  function groupTitle(key: string, label?: string): string {
    if (label) return label;
    return t(`modelPicker.group.${key}`);
  }

  return (
    <div className="model-picker" ref={ref} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button type="button" className="model-picker-trigger" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {model || t("modelPicker.trigger")}
      </button>
      {open && (
        <div className="model-picker-menu">
          <input
            ref={searchRef}
            className="model-picker-search"
            type="search"
            placeholder={t("modelPicker.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="model-picker-list">
            {groups.map((group) => (
              <div key={group.key}>
                <div className="model-picker-group">{groupTitle(group.key, group.label)}</div>
                {group.items.map((m) => {
                  const modelId = m.localModelId ?? m.id;
                  const active = modelId === model && currentEffort !== "legal";
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={`model-picker-item ${active ? "model-picker-item-on" : ""}`}
                      onClick={() => {
                        setOpen(false);
                        // No point sending a switch request the server will just reject: go straight to where the key gets added instead.
                        if (m.configured) onChange(modelId, m.family, m.baseUrl);
                        else onNeedsKey();
                      }}
                    >
                      <div className="model-picker-text">
                        <div className="model-picker-name">{m.id}</div>
                        {BLURB_KEYS[m.id] && <div className="model-picker-blurb">{t(BLURB_KEYS[m.id]!)}</div>}
                      </div>
                      {!m.configured && <span className="model-picker-chip model-picker-chip-warn">{t("modelPicker.keyShort")}</span>}
                      {m.configured && m.local && m.running === false && <span className="model-picker-chip">{t("modelPicker.stopped")}</span>}
                      {active && <span className="model-picker-check">✓</span>}
                    </button>
                  );
                })}
              </div>
            ))}
            {showLegal && (
              <div>
                <div className="model-picker-group">{t("modelPicker.specialists")}</div>
                <button
                  type="button"
                  className={`model-picker-item ${currentEffort === "legal" ? "model-picker-item-on" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    onSelectLegal();
                  }}
                >
                  <div className="model-picker-text">
                    <div className="model-picker-name">{t("modelPicker.legal")}</div>
                    <div className="model-picker-blurb">{t("modelPicker.legalBlurb")}</div>
                  </div>
                  {currentEffort === "legal" && <span className="model-picker-check">✓</span>}
                </button>
              </div>
            )}
            {groups.length === 0 && !showLegal && <div className="model-picker-empty">{t("modelPicker.noMatch")}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
