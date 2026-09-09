import { useEffect, useState } from "react";

interface InstalledModel {
  id: string;
  tags: string[];
  size?: string;
  parameters?: string;
  quantization?: string;
  architecture?: string;
}

interface SearchResult {
  name: string;
  description?: string;
  downloads: number;
  stars: number;
  source: string;
  official: boolean;
  size?: number;
}

function displayTag(m: InstalledModel): string {
  return m.tags[0]?.replace(/^docker\.io\//, "") ?? m.id;
}

/**
 * Docker Model Runner integration: browse Docker Hub's `ai/` namespace +
 * HuggingFace, pull a model with real streamed progress, see what's
 * already installed. Anything pulled here shows up automatically in the
 * model picker on the next refresh — detectLocalProviders (server-side)
 * already probes Model Runner's own OpenAI-compatible gateway, so there's
 * no separate "make it usable" step.
 */
export function DockerModelsPanel({ onClose }: { onClose: () => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState<InstalledModel[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullLog, setPullLog] = useState<string[]>([]);
  const [pullError, setPullError] = useState<string | null>(null);

  function refreshInstalled() {
    fetch("/api/docker-models/installed")
      .then((r) => r.json())
      .then((d: { models: InstalledModel[] }) => setInstalled(d.models))
      .catch(() => setInstalled([]));
  }

  function runSearch(q: string) {
    setSearching(true);
    fetch(`/api/docker-models/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((d: { results: SearchResult[] }) => setResults(d.results))
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
    // Only when availability first resolves — search itself is triggered by the search box below.
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

  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

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

  const installedNames = new Set(installed.map((m) => displayTag(m)));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Models</div>

        {available === false && (
          <p className="settings-hint">
            Docker Model Runner isn't available — install/enable it (Docker Desktop 4.40+, or <code>docker model install-runner</code> on Docker
            Engine) to browse and pull local models here.
          </p>
        )}

        {available === true && (
          <>
            <p className="settings-hint">
              Pulled models run locally and show up automatically in the model picker — nothing else to configure.
            </p>

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
                    const tag = displayTag(m);
                    return (
                      <div className="mcp-row" key={m.id}>
                        <div className="mcp-row-main">
                          <span className="mcp-icon">🧩</span>
                          <div>
                            <div className="mcp-name">{tag}</div>
                            <div className="mcp-meta">
                              {[m.parameters, m.quantization, m.size].filter(Boolean).join(" · ")}
                            </div>
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
        )}

        <div className="modal-actions">
          <button className="btn btn-allow" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
