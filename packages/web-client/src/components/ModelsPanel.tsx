import { useEffect, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";

interface OllamaModel {
  name: string;
  size: number;
  parameterSize?: string;
  quantization?: string;
  supportsTools?: boolean;
}

interface DockerModel {
  id: string;
  tags: string[];
  size?: string;
  parameters?: string;
  quantization?: string;
  architecture?: string;
}

interface DockerSearchResult {
  name: string;
  description?: string;
  downloads: number;
  stars: number;
  source: string;
  official: boolean;
  size?: number;
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${n} B`;
}

function displayDockerTag(m: DockerModel): string {
  return m.tags[0]?.replace(/^docker\.io\//, "") ?? m.id;
}

/**
 * Real, reported ollama pull that never had a client panel: the
 * /api/ollama-models/* REST routes existed server-side, but nothing in
 * the browser ever called them — "Models" only ever showed Docker Model
 * Runner, even though every real local model in this project's own
 * testing came from Ollama. Two tabs, each managing its own real
 * install/pull/remove — Ollama has no search catalog of its own (pull is
 * always by exact name), unlike Docker Hub/HuggingFace's real search.
 */
function OllamaSection() {
  const { t } = useLanguage();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState<OllamaModel[]>([]);
  const [pullName, setPullName] = useState("");
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [pullStatus, setPullStatus] = useState<string | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  function refreshInstalled() {
    fetch("/api/ollama-models/installed")
      .then((r) => r.json())
      .then((d: { models: OllamaModel[] }) => setInstalled(d.models))
      .catch(() => setInstalled([]));
  }

  useEffect(() => {
    fetch("/api/ollama-models/status")
      .then((r) => r.json())
      .then((d: { available: boolean }) => setAvailable(d.available));
  }, []);

  useEffect(() => {
    if (available) refreshInstalled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  function pull(name: string) {
    if (!name.trim()) return;
    setPulling(name);
    setPullPercent(0);
    setPullStatus(null);
    setPullError(null);
    const source = new EventSource(`/api/ollama-models/pull?name=${encodeURIComponent(name)}`);
    source.addEventListener("progress", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { status: string; completed?: number; total?: number };
      setPullStatus(p.status);
      if (p.total) setPullPercent(Math.round(((p.completed ?? 0) / p.total) * 100));
    });
    source.addEventListener("done", () => {
      source.close();
      setPulling(null);
      setPullName("");
      refreshInstalled();
    });
    source.addEventListener("error", (e) => {
      const raw = (e as MessageEvent).data;
      if (raw) setPullError(JSON.parse(raw) as string);
      source.close();
      setPulling(null);
    });
  }

  async function removeModel(name: string) {
    if (!window.confirm(t("models.confirmRemove", { name }))) return;
    setRemoving(name);
    setRemoveError(null);
    try {
      const res = await fetch(`/api/ollama-models?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      refreshInstalled();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(null);
    }
  }

  if (available === false) {
    return <p className="settings-hint">{t("models.ollamaUnavailable")}</p>;
  }

  return (
    <>
      <p className="settings-hint">{t("models.autoConfigHint")}</p>

      <div className="sidebar-section-label">{t("models.installed")}</div>
      <div className="mcp-list">
        {installed.map((m) => (
          <div className="mcp-row" key={m.name}>
            <div className="mcp-row-main">
              <span className="mcp-icon">🦙</span>
              <div>
                <div className="mcp-name">
                  {m.name} {m.supportsTools && <span className="model-badge">tools</span>}
                </div>
                <div className="mcp-meta">{[m.parameterSize, m.quantization, formatBytes(m.size)].filter(Boolean).join(" · ")}</div>
              </div>
            </div>
            <div className="mcp-row-actions">
              <button className="btn btn-ghost btn-danger" onClick={() => removeModel(m.name)} disabled={removing !== null}>
                {removing === m.name ? t("models.removing") : t("models.remove")}
              </button>
            </div>
          </div>
        ))}
        {available === true && installed.length === 0 && <div className="sidebar-empty">{t("models.noneOllama")}</div>}
        {available === null && <div className="sidebar-empty">{t("models.checking")}</div>}
      </div>
      {removeError && <div className="docker-models-error">{t("models.removeFailed", { error: removeError })}</div>}

      <div className="sidebar-section-label">{t("models.pullSection")}</div>
      <div className="docker-models-search-row">
        <input
          placeholder={t("models.pullPlaceholder")}
          value={pullName}
          onChange={(e) => setPullName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") pull(pullName);
          }}
          disabled={pulling !== null}
        />
        <button className="btn btn-allow" onClick={() => pull(pullName)} disabled={pulling !== null || !pullName.trim()}>
          {pulling ? t("models.pulling") : t("models.pull")}
        </button>
      </div>
      {pulling && (
        <div className="pull-progress">
          <div className="pull-progress-track">
            <div className="pull-progress-fill" style={{ width: `${pullPercent ?? 0}%` }} />
          </div>
          <div className="pull-progress-label">
            {pullStatus ?? t("models.starting")} {pullPercent !== null ? `${pullPercent}%` : ""}
          </div>
        </div>
      )}
      {pullError && <div className="docker-models-error">{t("models.pullFailed", { error: pullError })}</div>}
    </>
  );
}

function DockerSection() {
  const { t } = useLanguage();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState<DockerModel[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DockerSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullLog, setPullLog] = useState<string[]>([]);
  const [pullError, setPullError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  function refreshInstalled() {
    fetch("/api/docker-models/installed")
      .then((r) => r.json())
      .then((d: { models: DockerModel[] }) => setInstalled(d.models))
      .catch(() => setInstalled([]));
  }

  function runSearch(q: string) {
    setSearching(true);
    fetch(`/api/docker-models/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((d: { results: DockerSearchResult[] }) => setResults(d.results))
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  }

  useEffect(() => {
    fetch("/api/docker-models/status")
      .then((r) => r.json())
      .then((d: { available: boolean }) => setAvailable(d.available));
  }, []);

  useEffect(() => {
    if (available) {
      refreshInstalled();
      runSearch("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  function pull(name: string) {
    setPulling(name);
    setPullLog([]);
    setPullError(null);
    const source = new EventSource(`/api/docker-models/pull?name=${encodeURIComponent(name)}`);
    source.addEventListener("line", (e) => {
      const line = JSON.parse((e as MessageEvent).data) as string;
      setPullLog((log) => [...log, line]);
    });
    source.addEventListener("done", () => {
      source.close();
      setPulling(null);
      refreshInstalled();
    });
    source.addEventListener("error", (e) => {
      const raw = (e as MessageEvent).data;
      if (raw) setPullError(JSON.parse(raw) as string);
      source.close();
      setPulling(null);
    });
  }

  async function removeModel(name: string) {
    if (!window.confirm(t("models.confirmRemove", { name }))) return;
    setRemoving(name);
    setRemoveError(null);
    try {
      const res = await fetch(`/api/docker-models?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      refreshInstalled();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(null);
    }
  }

  async function removeAll() {
    if (installed.length === 0) return;
    if (!window.confirm(t("models.confirmRemoveAll", { count: installed.length }))) return;
    setRemoving("*");
    setRemoveError(null);
    try {
      const res = await fetch("/api/docker-models/purge", { method: "DELETE" });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      refreshInstalled();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(null);
    }
  }

  const installedNames = new Set(installed.map((m) => displayDockerTag(m)));

  if (available === false) {
    return <p className="settings-hint">{t("models.dockerUnavailable")}</p>;
  }

  return (
    <>
      <p className="settings-hint">{t("models.autoConfigHint")}</p>

      {installed.length > 0 && (
        <>
          <div className="sidebar-section-label docker-models-installed-header">
            <span>{t("models.installed")}</span>
            <button className="btn btn-ghost btn-danger" onClick={removeAll} disabled={removing !== null}>
              {removing === "*" ? t("models.removing") : t("models.removeAll")}
            </button>
          </div>
          <div className="mcp-list">
            {installed.map((m) => {
              const tag = displayDockerTag(m);
              return (
                <div className="mcp-row" key={m.id}>
                  <div className="mcp-row-main">
                    <span className="mcp-icon">🧩</span>
                    <div>
                      <div className="mcp-name">{tag}</div>
                      <div className="mcp-meta">{[m.parameters, m.quantization, m.size].filter(Boolean).join(" · ")}</div>
                    </div>
                  </div>
                  <div className="mcp-row-actions">
                    <button className="btn btn-ghost btn-danger" onClick={() => removeModel(tag)} disabled={removing !== null}>
                      {removing === tag ? t("models.removing") : t("models.remove")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {removeError && <div className="docker-models-error">{t("models.removeFailed", { error: removeError })}</div>}
        </>
      )}

      <div className="sidebar-section-label">{t("models.searchSection")}</div>
      <div className="docker-models-search-row">
        <input
          placeholder={t("models.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") runSearch(query);
          }}
        />
        <button className="btn btn-ghost" onClick={() => runSearch(query)} disabled={searching}>
          {searching ? "…" : t("models.search")}
        </button>
      </div>

      <div className="mcp-list">
        {results.map((r) => (
          <div className="mcp-row" key={r.name}>
            <div className="mcp-row-main">
              <span className="mcp-icon">{r.official ? "✅" : "🧩"}</span>
              <div>
                <div className="mcp-name">{r.name}</div>
                <div className="mcp-meta">
                  {r.source} · {r.downloads.toLocaleString()} downloads
                  {r.description ? ` · ${r.description}` : ""}
                </div>
              </div>
            </div>
            <div className="mcp-row-actions">
              {installedNames.has(r.name) ? (
                <span className="model-picker-blurb">{t("models.installedTag")}</span>
              ) : pulling === r.name ? (
                <span className="model-picker-blurb">{t("models.pullingTag")}</span>
              ) : (
                <button className="btn btn-allow" onClick={() => pull(r.name)} disabled={pulling !== null}>
                  {t("models.pull")}
                </button>
              )}
            </div>
          </div>
        ))}
        {results.length === 0 && !searching && <div className="sidebar-empty">{t("models.noResults")}</div>}
      </div>

      {pulling && (
        <div className="docker-models-pull-log">
          {pullLog.slice(-8).map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      {pullError && <div className="docker-models-error">{t("models.pullFailed", { error: pullError })}</div>}
    </>
  );
}

export function ModelsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  const [tab, setTab] = useState<"ollama" | "docker">("ollama");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-header-icon">🧩</span>
          <span className="panel-header-title">{t("models.title")}</span>
          <button className="panel-header-close" onClick={onClose} aria-label={t("settings.close")}>
            ×
          </button>
        </div>

        <div className="panel-tabs">
          <button type="button" className={`panel-tab ${tab === "ollama" ? "panel-tab-active" : ""}`} onClick={() => setTab("ollama")}>
            {t("models.tabOllama")}
          </button>
          <button type="button" className={`panel-tab ${tab === "docker" ? "panel-tab-active" : ""}`} onClick={() => setTab("docker")}>
            {t("models.tabDocker")}
          </button>
        </div>

        {tab === "ollama" ? <OllamaSection /> : <DockerSection />}
      </div>
    </div>
  );
}
