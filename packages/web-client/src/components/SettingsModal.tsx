import { useEffect, useState } from "react";

interface ConfigShape {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  visionProvider?: string;
  visionModel?: string;
  visionBaseUrl?: string;
  visionApiKey?: string;
}

const FIELD_LABELS: Record<keyof ConfigShape, string> = {
  provider: "Provider (anthropic | openai-compatible)",
  model: "Model",
  baseUrl: "Base URL (openai-compatible only)",
  apiKey: "API key",
  visionProvider: "Vision provider",
  visionModel: "Vision model",
  visionBaseUrl: "Vision base URL",
  visionApiKey: "Vision API key",
};

const SECRET_FIELDS = new Set(["apiKey", "visionApiKey"]);

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [saved, setSaved] = useState<ConfigShape>({});
  const [draft, setDraft] = useState<Partial<ConfigShape>>({});
  const [showVision, setShowVision] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data: { config: ConfigShape }) => setSaved(data.config));
  }, []);

  function set<K extends keyof ConfigShape>(key: K, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function handleSave() {
    setStatus("Saving…");
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    const data = await res.json();
    setStatus(data.note ?? "Saved.");
    setDraft({});
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: { config: ConfigShape }) => setSaved(d.config));
  }

  function field(key: keyof ConfigShape) {
    const isSecret = SECRET_FIELDS.has(key);
    const currentValue = draft[key] ?? "";
    const placeholder = isSecret && saved[key] ? `saved: ${saved[key]}` : (saved[key] ?? "");
    return (
      <label className="settings-field" key={key}>
        <span>{FIELD_LABELS[key]}</span>
        <input
          type={isSecret ? "password" : "text"}
          value={currentValue}
          placeholder={placeholder}
          onChange={(e) => set(key, e.target.value)}
        />
      </label>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Settings — provider & tokens</div>
        <p className="settings-hint">
          Saved to <code>~/.finanfa-code/config.json</code>. Existing open chats keep their current provider — start a new chat to pick up a change.
        </p>

        {field("provider")}
        {field("model")}
        {field("baseUrl")}
        {field("apiKey")}

        <button className="settings-toggle" onClick={() => setShowVision((v) => !v)}>
          {showVision ? "− Hide" : "+ Show"} vision routing (optional)
        </button>
        {showVision && (
          <>
            {field("visionProvider")}
            {field("visionModel")}
            {field("visionBaseUrl")}
            {field("visionApiKey")}
          </>
        )}

        {status && <div className="settings-status">{status}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-allow" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
