import { useEffect, useState } from "react";

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
    if (!window.confirm(`Remove "${name}"? This deletes it from disk — you'd need to pull it again to use it.`)) return;
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
    return (
      <p className="settings-hint">
        Ollama isn't reachable at <code>localhost:11434</code> — install it from <code>ollama.com</code> and make sure it's running to manage
        models here.
      </p>
    );
  }

  return (
    <>
      <p className="settings-hint">Pulled models run locally and show up automatically in the model picker — nothing else to configure.</p>

      <div className="sidebar-section-label">Installed</div>
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
                {removing === m.name ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        ))}
        {available === true && installed.length === 0 && <div className="sidebar-empty">No models pulled yet.</div>}
        {available === null && <div className="sidebar-empty">Checking…</div>}
      </div>
      {removeError && <div className="docker-models-error">Remove failed: {removeError}</div>}

      <div className="sidebar-section-label">Pull a model</div>
      <div className="docker-models-search-row">
        <input
          placeholder="e.g. qwen2.5-coder:7b"
          value={pullName}
          onChange={(e) => setPullName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") pull(pullName);
          }}
          disabled={pulling !== null}
        />
        <button className="btn btn-allow" onClick={() => pull(pullName)} disabled={pulling !== null || !pullName.trim()}>
          {pulling ? "Pulling…" : "Pull"}
        </button>
      </div>
      {pulling && (
        <div className="pull-progress">
          <div className="pull-progress-track">
            <div className="pull-progress-fill" style={{ width: `${pullPercent ?? 0}%` }} />
          </div>
          <div className="pull-progress-label">
            {pullStatus ?? "starting…"} {pullPercent !== null ? `${pullPercent}%` : ""}
          </div>
        </div>
      )}
      {pullError && <div className="docker-models-error">Pull failed: {pullError}</div>}
    </>
  );
}

function DockerSection() {
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
    if (!window.confirm(`Remove "${name}"? This deletes it from disk — you'd need to pull it again to use it.`)) return;
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
    if (!window.confirm(`Remove all ${installed.length} installed model(s)? This deletes every one of them from disk.`)) return;
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
    return (
      <p className="settings-hint">
        Docker Model Runner isn't available — install/enable it (Docker Desktop 4.40+, or <code>docker model install-runner</code> on Docker
        Engine) to browse and pull local models here.
      </p>
    );
  }

  return (
    <>
      <p className="settings-hint">Pulled models run locally and show up automatically in the model picker — nothing else to configure.</p>

      {installed.length > 0 && (
        <>
          <div className="sidebar-section-label docker-models-installed-header">
            <span>Installed</span>
            <button className="btn btn-ghost btn-danger" onClick={removeAll} disabled={removing !== null}>
              {removing === "*" ? "Removing…" : "Remove all"}
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
                      {removing === tag ? "Removing…" : "Remove"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {removeError && <div className="docker-models-error">Remove failed: {removeError}</div>}
        </>
      )}

      <div className="sidebar-section-label">Search Docker Hub / HuggingFace</div>
      <div className="docker-models-search-row">
        <input
          placeholder="qwen, llama, phi…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") runSearch(query);
          }}
        />
        <button className="btn btn-ghost" onClick={() => runSearch(query)} disabled={searching}>
          {searching ? "…" : "Search"}
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
                <span className="model-picker-blurb">installed</span>
              ) : pulling === r.name ? (
                <span className="model-picker-blurb">pulling…</span>
              ) : (
                <button className="btn btn-allow" onClick={() => pull(r.name)} disabled={pulling !== null}>
                  Pull
                </button>
              )}
            </div>
          </div>
        ))}
        {results.length === 0 && !searching && <div className="sidebar-empty">No results.</div>}
      </div>

      {pulling && (
        <div className="docker-models-pull-log">
          {pullLog.slice(-8).map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      {pullError && <div className="docker-models-error">Pull failed: {pullError}</div>}
    </>
  );
}

export function ModelsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"ollama" | "docker">("ollama");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-header-icon">🧩</span>
          <span className="panel-header-title">Models</span>
          <button className="panel-header-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="panel-tabs">
          <button type="button" className={`panel-tab ${tab === "ollama" ? "panel-tab-active" : ""}`} onClick={() => setTab("ollama")}>
            🦙 Ollama
          </button>
          <button type="button" className={`panel-tab ${tab === "docker" ? "panel-tab-active" : ""}`} onClick={() => setTab("docker")}>
            🧩 Docker Model Runner
          </button>
        </div>

        {tab === "ollama" ? <OllamaSection /> : <DockerSection />}
      </div>
    </div>
  );
}
