import { useEffect, useState } from "react";

interface ConfigShape {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  anthropicApiKey?: string;
  visionProvider?: string;
  visionModel?: string;
  visionBaseUrl?: string;
  visionApiKey?: string;
}

type Theme = "dark" | "light";

function getStoredTheme(): Theme {
  try {
    return (localStorage.getItem("finanfa-theme") as Theme) ?? "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("finanfa-theme", theme);
  } catch {
    // best-effort — a private window or blocked storage just means the
    // choice doesn't persist across reloads, not a reason to fail.
  }
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [saved, setSaved] = useState<ConfigShape>({});
  const [anthropicKeyDraft, setAnthropicKeyDraft] = useState("");
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [otherKeyDraft, setOtherKeyDraft] = useState("");
  const [showVision, setShowVision] = useState(false);
  const [visionDraft, setVisionDraft] = useState<Partial<ConfigShape>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(getStoredTheme());

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data: { config: ConfigShape }) => setSaved(data.config));
  }, []);

  async function refresh() {
    const res = await fetch("/api/config");
    const data = (await res.json()) as { config: ConfigShape };
    setSaved(data.config);
  }

  async function saveAnthropic() {
    if (!anthropicKeyDraft.trim()) return;
    setStatus("Saving…");
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anthropicApiKey: anthropicKeyDraft.trim() }),
    });
    const data = await res.json();
    setStatus(data.note ?? "Saved.");
    setAnthropicKeyDraft("");
    refresh();
  }

  async function saveOther() {
    setStatus("Saving…");
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai-compatible",
        baseUrl: baseUrlDraft.trim() || undefined,
        model: modelDraft.trim() || undefined,
        apiKey: otherKeyDraft.trim() || undefined,
      }),
    });
    const data = await res.json();
    setStatus(data.note ?? "Saved.");
    setBaseUrlDraft("");
    setModelDraft("");
    setOtherKeyDraft("");
    refresh();
  }

  async function saveVision() {
    setStatus("Saving…");
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(visionDraft),
    });
    const data = await res.json();
    setStatus(data.note ?? "Saved.");
    setVisionDraft({});
    refresh();
  }

  function handleThemeChange(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Settings</div>

        <div className="side-panel-title settings-first-title">Appearance</div>
        <div className="theme-switch">
          <button className={`btn btn-toggle ${theme === "dark" ? "btn-toggle-on" : ""}`} onClick={() => handleThemeChange("dark")}>
            🌙 Dark
          </button>
          <button className={`btn btn-toggle ${theme === "light" ? "btn-toggle-on" : ""}`} onClick={() => handleThemeChange("light")}>
            ☀️ Light
          </button>
        </div>

        <div className="side-panel-title">Models & tokens</div>
        <p className="settings-hint">
          Saved to <code>~/.finanfa-code/config.json</code>. Adding a key here doesn't disturb whichever provider is already active — start a new chat
          (or switch models mid-chat) to use it.
        </p>

        <div className="provider-card">
          <div className="provider-card-title">
            Claude (Anthropic)
            {/* apiKey is a single field shared with the "Other provider" card below, scoped by
                which one `provider` currently names — only anthropicApiKey unambiguously belongs
                here, so a saved apiKey only counts when provider is actually "anthropic" too
                (otherwise it's the other card's key and showing "configured" here would be a lie). */}
            {(saved.anthropicApiKey || (saved.provider === "anthropic" && saved.apiKey)) && <span className="provider-badge">configured</span>}
          </div>
          <p className="settings-hint">
            {saved.anthropicApiKey ? `Key saved: ${saved.anthropicApiKey}` : "No key saved here yet — works anyway if ANTHROPIC_API_KEY is set on the server."}
          </p>
          <div className="provider-card-row">
            <input
              type="password"
              placeholder="sk-ant-…"
              value={anthropicKeyDraft}
              onChange={(e) => setAnthropicKeyDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveAnthropic()}
            />
            <button className="btn btn-allow" onClick={saveAnthropic} disabled={!anthropicKeyDraft.trim()}>
              Save
            </button>
          </div>
        </div>

        <div className="provider-card">
          <div className="provider-card-title">
            Other provider <span className="provider-card-sub">(Ollama, OpenRouter, LM Studio, self-hosted…)</span>
            {saved.baseUrl && <span className="provider-badge">configured</span>}
          </div>
          <label className="settings-field">
            <span>Base URL</span>
            <input
              type="text"
              placeholder={saved.baseUrl ?? "https://…/v1"}
              value={baseUrlDraft}
              onChange={(e) => setBaseUrlDraft(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>Model</span>
            <input type="text" placeholder={saved.model ?? "e.g. llama3.1"} value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} />
          </label>
          <label className="settings-field">
            <span>API key (optional)</span>
            <input
              type="password"
              placeholder={saved.apiKey ? `saved: ${saved.apiKey}` : "leave blank if none needed"}
              value={otherKeyDraft}
              onChange={(e) => setOtherKeyDraft(e.target.value)}
            />
          </label>
          <button className="btn btn-allow" onClick={saveOther}>
            Save
          </button>
        </div>

        <button className="settings-toggle" onClick={() => setShowVision((v) => !v)}>
          {showVision ? "− Hide" : "+ Show"} vision routing (optional)
        </button>
        {showVision && (
          <div className="provider-card">
            <p className="settings-hint">A second model used only for the turn right after a screenshot, if your main model can't see images.</p>
            {(["visionProvider", "visionModel", "visionBaseUrl", "visionApiKey"] as const).map((key) => (
              <label className="settings-field" key={key}>
                <span>{key.replace("vision", "Vision ")}</span>
                <input
                  type={key === "visionApiKey" ? "password" : "text"}
                  value={visionDraft[key] ?? ""}
                  placeholder={key === "visionApiKey" && saved[key] ? `saved: ${saved[key]}` : (saved[key] ?? "")}
                  onChange={(e) => setVisionDraft((d) => ({ ...d, [key]: e.target.value }))}
                />
              </label>
            ))}
            <button className="btn btn-allow" onClick={saveVision}>
              Save vision routing
            </button>
          </div>
        )}

        {status && <div className="settings-status">{status}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
