import { useEffect, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";

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
  const { language, setLanguage, t } = useLanguage();
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
    setStatus(t("settings.saving"));
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anthropicApiKey: anthropicKeyDraft.trim() }),
    });
    const data = await res.json();
    setStatus(data.note ?? t("settings.saved"));
    setAnthropicKeyDraft("");
    refresh();
  }

  async function saveOther() {
    setStatus(t("settings.saving"));
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
    setStatus(data.note ?? t("settings.saved"));
    setBaseUrlDraft("");
    setModelDraft("");
    setOtherKeyDraft("");
    setApiKeysDraft("");
    refresh();
  }

  async function saveVision() {
    setStatus(t("settings.saving"));
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(visionDraft),
    });
    const data = await res.json();
    setStatus(data.note ?? t("settings.saved"));
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
        <div className="modal-title">{t("settings.title")}</div>

        <div className="side-panel-title settings-first-title">{t("settings.appearance")}</div>
        <div className="theme-switch">
          <button className={`btn btn-toggle ${theme === "dark" ? "btn-toggle-on" : ""}`} onClick={() => handleThemeChange("dark")}>
            {t("settings.dark")}
          </button>
          <button className={`btn btn-toggle ${theme === "light" ? "btn-toggle-on" : ""}`} onClick={() => handleThemeChange("light")}>
            {t("settings.light")}
          </button>
        </div>

        <div className="side-panel-title">{t("settings.language")}</div>
        <div className="theme-switch">
          <button className={`btn btn-toggle ${language === "en" ? "btn-toggle-on" : ""}`} onClick={() => setLanguage("en")}>
            🇬🇧 English
          </button>
          <button className={`btn btn-toggle ${language === "fr" ? "btn-toggle-on" : ""}`} onClick={() => setLanguage("fr")}>
            🇫🇷 Français
          </button>
        </div>

        <div className="side-panel-title">{t("settings.modelsAndTokens")}</div>
        <p className="settings-hint">{t("settings.modelsHint")}</p>

        <div className="provider-card">
          <div className="provider-card-title">
            {t("settings.anthropicTitle")}
            {/* apiKey is a single field shared with the "Other provider" card below, scoped by
                which one `provider` currently names — only anthropicApiKey unambiguously belongs
                here, so a saved apiKey only counts when provider is actually "anthropic" too
                (otherwise it's the other card's key and showing "configured" here would be a lie). */}
            {(saved.anthropicApiKey || (saved.provider === "anthropic" && saved.apiKey)) && (
              <span className="provider-badge">{t("settings.configured")}</span>
            )}
          </div>
          <p className="settings-hint">
            {saved.anthropicApiKey ? t("settings.anthropicKeySaved", { key: saved.anthropicApiKey }) : t("settings.anthropicNoKey")}
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
              {t("settings.save")}
            </button>
          </div>
        </div>

        <div className="provider-card">
          <div className="provider-card-title">
            {t("settings.otherProviderTitle")} <span className="provider-card-sub">{t("settings.otherProviderSub")}</span>
            {saved.baseUrl && <span className="provider-badge">{t("settings.configured")}</span>}
          </div>
          <div className="provider-preset-row">
            <span>{t("settings.quickSetup")}</span>
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
            <span>{t("settings.baseUrl")}</span>
            <input
              type="text"
              placeholder={saved.baseUrl ?? "https://…/v1"}
              value={baseUrlDraft}
              onChange={(e) => setBaseUrlDraft(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>{t("settings.model")}</span>
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
            <span>{t("settings.apiKeyOptional")}</span>
            <input
              type="password"
              placeholder={saved.apiKey ? t("settings.apiKeySaved", { key: saved.apiKey }) : t("settings.apiKeyBlank")}
              value={otherKeyDraft}
              onChange={(e) => setOtherKeyDraft(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>
              {t("settings.multipleApiKeys")}{" "}
              {savedApiKeys.length > 0 && <span className="provider-badge">{t("settings.savedCount", { count: savedApiKeys.length })}</span>}
            </span>
            <p className="settings-hint">{t("settings.multipleKeysHint")}</p>
            {savedApiKeys.length > 0 && <p className="settings-hint">{t("settings.savedKeysList", { keys: savedApiKeys.join(", ") })}</p>}
            <textarea
              className="instructions-textarea"
              placeholder={"key1\nkey2\nkey3"}
              value={apiKeysDraft}
              onChange={(e) => setApiKeysDraft(e.target.value)}
            />
          </label>
          <button className="btn btn-allow" onClick={saveOther}>
            {t("settings.save")}
          </button>
        </div>

        <button className="settings-toggle" onClick={() => setShowVision((v) => !v)}>
          {showVision ? t("settings.hideVision") : t("settings.showVision")}
        </button>
        {showVision && (
          <div className="provider-card">
            <p className="settings-hint">{t("settings.visionHint")}</p>
            {(["visionProvider", "visionModel", "visionBaseUrl", "visionApiKey"] as const).map((key) => (
              <label className="settings-field" key={key}>
                <span>{key.replace("vision", "Vision ")}</span>
                <input
                  type={key === "visionApiKey" ? "password" : "text"}
                  value={visionDraft[key] ?? ""}
                  placeholder={key === "visionApiKey" && saved[key] ? t("settings.apiKeySaved", { key: saved[key]! }) : (saved[key] ?? "")}
                  onChange={(e) => setVisionDraft((d) => ({ ...d, [key]: e.target.value }))}
                />
              </label>
            ))}
            <button className="btn btn-allow" onClick={saveVision}>
              {t("settings.saveVisionRouting")}
            </button>
          </div>
        )}

        {status && <div className="settings-status">{status}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            {t("settings.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
