const PROBE_TIMEOUT_MS = 800;

export interface LocalModel {
  /** Model id as the server itself names it (e.g. "llama3.1:8b") — used both for display and as the actual model string sent to the provider. */
  id: string;
  /** Which local runtime served it — for display only ("Ollama", "LM Studio", ...). */
  source: string;
  /** OpenAI-compatible base URL to actually talk to this server. */
  baseUrl: string;
}

interface Candidate {
  port: number;
  source: string;
}

// Every one of these speaks the OpenAI-compatible /v1/models endpoint on its
// own default port, unauthenticated, when running locally — verified
// directly for Ollama (real local instance, real downloaded models) and
// documented for the others. Unsloth is deliberately not in this list: it's
// a fine-tuning library, not a serving runtime — it has no local HTTP API of
// its own to detect (a model trained with it still needs Ollama/llama.cpp/
// vLLM/etc. to actually serve it, which is what gets detected here).
const CANDIDATES: Candidate[] = [
  { port: 11434, source: "Ollama" },
  { port: 1234, source: "LM Studio" },
  { port: 8080, source: "llama.cpp" },
  { port: 8000, source: "vLLM" },
  // Docker Model Runner (`docker model ...`) — its OpenAI-compatible gateway
  // listens on 12434 by default when the runner is installed/enabled.
  // Verified directly against a real running instance with real pulled
  // models (granite/qwen2.5-coder/smollm/...), not just documented like the
  // others above.
  { port: 12434, source: "Docker Model Runner" },
];

async function probe(candidate: Candidate): Promise<LocalModel[]> {
  const baseUrl = `http://localhost:${candidate.port}/v1`;
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => ({ id: m.id, source: candidate.source, baseUrl }));
  } catch {
    // Nothing listening on this port, or it responded with something that
    // isn't the OpenAI-compatible shape — either way, just not a hit.
    return [];
  }
}

/**
 * Probes a short list of well-known local-model-server ports in parallel and
 * returns whatever's actually listening and answering with a real model
 * list — no configuration needed, matching how the web UI's model picker
 * otherwise only shows what the user explicitly configured. Always resolves
 * (a dead/absent server is not an error here, just zero results from it).
 */
export async function detectLocalProviders(): Promise<LocalModel[]> {
  const results = await Promise.all(CANDIDATES.map(probe));
  return results.flat();
}
