import { useEffect, useRef, useState } from "react";

const BLURBS: Record<string, string> = {
  "claude-opus-5": "For complex tasks",
  "claude-sonnet-5": "Most efficient for everyday tasks",
  "claude-haiku-4-5-20251001": "Fastest for quick answers",
};

export function ModelPicker({ models, model, onChange }: { models: string[]; model: string; onChange: (model: string) => void }) {
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
              key={m}
              type="button"
              className="model-picker-item"
              onClick={() => {
                onChange(m);
                setOpen(false);
              }}
            >
              <div>
                <div className="model-picker-name">{m}</div>
                {BLURBS[m] && <div className="model-picker-blurb">{BLURBS[m]}</div>}
              </div>
              {m === model && <span className="model-picker-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
