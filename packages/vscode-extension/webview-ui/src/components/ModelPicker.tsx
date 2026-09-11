import { useEffect, useRef, useState } from "react";
import type { ModelOption } from "../hooks/useAgentBridge";

const BLURB: Record<string, string> = {
  "claude-opus-5": "Pour les tâches complexes",
  "claude-sonnet-5": "Le plus efficace au quotidien",
  "claude-haiku-4-5-20251001": "Le plus rapide pour des réponses courtes",
};

// Port of web-client's ModelPicker.tsx, i18n stripped to hardcoded French —
// fully props-driven, no changes to behavior.
export function ModelPicker({
  models,
  model,
  onChange,
  onNeedsKey,
}: {
  models: ModelOption[];
  model: string;
  onChange: (model: string, family: string, baseUrl?: string) => void;
  onNeedsKey: (model: string) => void;
}) {
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
        {model || "modèle"}
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
                  if (m.configured) onChange(modelId, m.family, m.baseUrl);
                  else onNeedsKey(m.id);
                }}
              >
                <div>
                  <div className="model-picker-name">{m.id}</div>
                  {BLURB[m.id] && <div className="model-picker-blurb">{BLURB[m.id]}</div>}
                  {!m.configured && <div className="model-picker-warn">clé API requise — voir ~/.finanfa-code/config.json</div>}
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
