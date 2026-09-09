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

// Known openai-compatible provider presets — DeepSeek's own pricing page
// gives its OpenAI-format base URL as exactly "https://api.deepseek.com"
// (no /v1 suffix; their server mounts /chat/completions directly there,
// matching this project's own OpenAiCompatibleProvider request path) and
// its three current model names. A preset only pre-fills the base URL and
// suggests model names via a <datalist> — it never supplies an API key,
// since this project has no way to know the user's own DeepSeek key.
const OPENAI_COMPATIBLE_PRESETS: Record<string, { baseUrl: string; models: string[] }> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"],
  },
};

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
  const [savedApiKeys, setSavedApiKeys] = useState<string[]>([]);
  const [anthropicKeyDraft, setAnthropicKeyDraft] = useState("");
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [otherKeyDraft, setOtherKeyDraft] = useState("");
  const [apiKeysDraft, setApiKeysDraft] = useState("");
  const [showVision, setShowVision] = useState(false);
  const [visionDraft, setVisionDraft] = useState<Partial<ConfigShape>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(getStoredTheme());

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    const res = await fetch("/api/config");
    const data = (await res.json()) as { config: ConfigShape; apiKeys?: string[] };
    setSaved(data.config);
    setSavedApiKeys(data.apiKeys ?? []);
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
    const apiKeys = apiKeysDraft
      .split(/[,\n]/)
      .map((k) => k.trim())
      .filter(Boolean);
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai-compatible",
        baseUrl: baseUrlDraft.trim() || undefined,
        model: modelDraft.trim() || undefined,
        apiKey: otherKeyDraft.trim() || undefined,
        // Only sent (and only replaces the saved pool) when the textarea
        // actually has something in it — leaving it blank means "don't
        // touch the saved keys", same as every other optional field here.
        ...(apiKeys.length > 0 ? { apiKeys } : {}),
      }),
    });
    const data = await res.json();
    setStatus(data.note ?? "Saved.");
    setBaseUrlDraft("");
    setModelDraft("");
    setOtherKeyDraft("");
    setApiKeysDraft("");
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
            Other provider <span className="provider-card-sub">(DeepSeek, Ollama, OpenRouter, LM Studio, self-hosted…)</span>
            {saved.baseUrl && <span className="provider-badge">configured</span>}
          </div>
          <div className="provider-preset-row">
            <span>Quick setup:</span>
            {Object.entries(OPENAI_COMPATIBLE_PRESETS).map(([key, preset]) => (
              <button
                key={key}
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setBaseUrlDraft(preset.baseUrl);
                  setModelDraft(preset.models[0] ?? "");
                }}
              >
                {key === "deepseek" ? "DeepSeek" : key}
              </button>
            ))}
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
            <input
              type="text"
              list="openai-compatible-model-suggestions"
              placeholder={saved.model ?? "e.g. llama3.1"}
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
            />
            <datalist id="openai-compatible-model-suggestions">
              {Object.values(OPENAI_COMPATIBLE_PRESETS)
                .flatMap((p) => p.models)
                .map((m) => (
                  <option key={m} value={m} />
                ))}
            </datalist>
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
          <label className="settings-field">
            <span>
              Multiple API keys (optional) {savedApiKeys.length > 0 && <span className="provider-badge">{savedApiKeys.length} saved</span>}
            </span>
            <p className="settings-hint">
              One per line — for a community sharing one model, e.g. several Laguna keys. Tried in order, automatically moving to the next if one is
              rate-limited or revoked. Leave blank to keep whatever's already saved.
            </p>
            {savedApiKeys.length > 0 && <p className="settings-hint">Saved: {savedApiKeys.join(", ")}</p>}
            <textarea
              className="instructions-textarea"
              placeholder={"key1\nkey2\nkey3"}
              value={apiKeysDraft}
              onChange={(e) => setApiKeysDraft(e.target.value)}
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
