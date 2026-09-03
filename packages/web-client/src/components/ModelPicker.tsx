import { useEffect, useRef, useState } from "react";

export interface ModelOption {
  id: string;
  family: string;
  configured: boolean;
}

const BLURBS: Record<string, string> = {
  "claude-opus-5": "For complex tasks",
  "claude-sonnet-5": "Most efficient for everyday tasks",
  "claude-haiku-4-5-20251001": "Fastest for quick answers",
};

export function ModelPicker({ models, model, onChange }: { models: ModelOption[]; model: string; onChange: (model: string, family: string) => void }) {
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
        {model || "model"}
      </button>
      {open && (
        <div className="model-picker-menu">
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              className="model-picker-item"
              onClick={() => {
                onChange(m.id, m.family);
                setOpen(false);
              }}
            >
              <div>
                <div className="model-picker-name">{m.id}</div>
                {BLURBS[m.id] && <div className="model-picker-blurb">{BLURBS[m.id]}</div>}
                {!m.configured && <div className="model-picker-warn">needs API key — set one in Settings</div>}
              </div>
              {m.id === model && <span className="model-picker-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
