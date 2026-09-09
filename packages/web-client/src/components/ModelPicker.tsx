import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";

export interface ModelOption {
  id: string;
  family: string;
  configured: boolean;
  /** Set for a detected local runtime (Ollama/LM Studio/...) — talk to this exact endpoint instead of whatever's saved in Settings. */
  baseUrl?: string;
  /** The real model string the provider expects — only differs from `id` for a local model, where `id` is a display label ("Ollama: llama3.1:8b") for the picker. */
  localModelId?: string;
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
}: {
  models: ModelOption[];
  model: string;
  onChange: (model: string, family: string, baseUrl?: string) => void;
  onNeedsKey: () => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div className="model-picker" ref={ref}>
      <button type="button" className="model-picker-trigger" onClick={() => setOpen((o) => !o)}>
        {model || t("modelPicker.trigger")}
      </button>
      {open && (
        <div className="model-picker-menu">
          {models.map((m) => {
            const modelId = m.localModelId ?? m.id;
            return (
              <button
                key={m.id}
                type="button"
                className="model-picker-item"
                onClick={() => {
                  setOpen(false);
                  // No point sending a switch request the server will just
                  // reject — go straight to where the key gets added instead.
                  if (m.configured) onChange(modelId, m.family, m.baseUrl);
                  else onNeedsKey();
                }}
              >
                <div>
                  <div className="model-picker-name">{m.id}</div>
                  {BLURB_KEYS[m.id] && <div className="model-picker-blurb">{t(BLURB_KEYS[m.id]!)}</div>}
                  {!m.configured && <div className="model-picker-warn">{t("modelPicker.needsKey")}</div>}
                </div>
                {modelId === model && <span className="model-picker-check">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
