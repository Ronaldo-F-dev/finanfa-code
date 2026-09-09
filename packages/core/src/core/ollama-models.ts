const OLLAMA_BASE_URL = "http://localhost:11434";

// Ollama's own model management — separate from local-providers.ts's
// detectLocalProviders (which only lists what's already installed via the
// OpenAI-compat /v1/models shim). This module talks to Ollama's native
// HTTP API directly (not the `ollama` CLI) since /api/pull's streaming
// NDJSON progress is a documented, stable contract, unlike scraping a
// terminal progress bar.

export interface OllamaModelInfo {
  name: string;
  size: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  contextLength?: number;
  /** From /api/tags' own "capabilities" field — real, reported bug: several installed models (yi-coder, gemma2) have no tool-calling support at all, so sending them this project's tool list fails outright (not a size/context problem, a hard incompatibility). Undefined when Ollama's response doesn't carry the field (an older Ollama version) — callers should treat that as "unknown", not "false". */
  supportsTools?: boolean;
}

export interface OllamaPullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/** Real availability check — Ollama's own version endpoint, not just "is the port open" (a different local runtime could be squatting :11434). */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/version`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listOllamaModels(): Promise<OllamaModelInfo[]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const body = (await res.json()) as {
    models: {
      name: string;
      size: number;
      details?: { parameter_size?: string; quantization_level?: string; family?: string };
      capabilities?: string[];
    }[];
  };
  return body.models.map((m) => ({
    name: m.name,
    size: m.size,
    parameterSize: m.details?.parameter_size,
    quantization: m.details?.quantization_level,
    family: m.details?.family,
    supportsTools: m.capabilities ? m.capabilities.includes("tools") : undefined,
  }));
}

/** Removes one pulled model — `DELETE /api/delete`. */
export async function deleteOllamaModel(name: string): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/delete`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Ollama /api/delete returned ${res.status}`);
  }
}

/**
 * Pulls a model, forwarding each real NDJSON progress line to `onProgress`
 * as it arrives (Ollama's documented streaming pull contract — status
 * strings like "pulling manifest" / "downloading" with completed/total
 * byte counts, then a final "success").
 */
export async function pullOllamaModel(name: string, onProgress: (p: OllamaPullProgress) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Ollama /api/pull returned ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastStatus = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as OllamaPullProgress & { error?: string };
      if (parsed.error) throw new Error(parsed.error);
      lastStatus = parsed.status;
      onProgress(parsed);
    }
  }
  if (lastStatus !== "success") throw new Error(`Ollama pull for "${name}" ended without a success status (last: "${lastStatus}")`);
}
