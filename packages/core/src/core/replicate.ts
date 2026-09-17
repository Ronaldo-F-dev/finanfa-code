// Real video/music generation via Replicate — closing the media-
// generation gap the honest generate_2d/generate_3d stubs (and
// generate_2d's later real OpenAI Images backend) never covered:
// neither OpenAI nor Gemini has a broadly-available, non-invite-only
// video- or music-generation API today, but Replicate hosts real, open
// models for both (video: e.g. Stable Video Diffusion, Minimax; music:
// e.g. MusicGen, Stable Audio) behind one simple, documented REST API,
// needing only an ordinary API token — no special access request.
//
// Deliberately generic: `model` (Replicate's own "owner/name" official-
// model shortcut, e.g. "minimax/video-01") and `input` (a raw object)
// are passed straight through, not a fixed set of named parameters —
// Replicate hosts hundreds of models, each with its own real input
// schema (prompt, duration, resolution, seed, ...), and hardcoding one
// shape here would either lock this to a single model or silently drop
// fields a different model actually needs. The calling agent is expected
// to know (or look up) the specific model's own input schema, the same
// "wrap the general capability, don't hardcode the specifics" choice
// run_mydevops.ts/run_remote_command make for their own wrapped tools.
const REPLICATE_API_BASE = "https://api.replicate.com";
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 300_000;

export interface ReplicateConfig {
  apiToken: string;
}

export function replicateConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReplicateConfig | undefined {
  const apiToken = env.REPLICATE_API_TOKEN;
  return apiToken ? { apiToken } : undefined;
}

interface ReplicatePrediction {
  id: string;
  status: string;
  output?: unknown;
  error?: string | null;
  urls?: { get?: string };
}

export type RunReplicateModelResult = { ok: true; outputUrls: string[] } | { ok: false; error: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createPrediction(config: ReplicateConfig, model: string, input: Record<string, unknown>, apiBaseUrl: string): Promise<{ ok: true; prediction: ReplicatePrediction } | { ok: false; error: string }> {
  let response: Response;
  let bodyText: string;
  try {
    response = await fetch(`${apiBaseUrl}/v1/models/${model}/predictions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });
    bodyText = await response.text();
  } catch (err) {
    return { ok: false, error: `Failed to reach Replicate: ${err instanceof Error ? err.message : String(err)}` };
  }
  let data: (ReplicatePrediction & { detail?: string }) | undefined;
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    return { ok: false, error: `Replicate returned an unparseable response (HTTP ${response.status}).` };
  }
  if (!response.ok || !data?.id) return { ok: false, error: data?.detail ?? `Replicate API error (HTTP ${response.status})` };
  return { ok: true, prediction: data };
}

async function pollPrediction(config: ReplicateConfig, getUrl: string, timeoutMs: number): Promise<{ ok: true; prediction: ReplicatePrediction } | { ok: false; error: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let response: Response;
    let bodyText: string;
    try {
      response = await fetch(getUrl, { headers: { Authorization: `Bearer ${config.apiToken}` } });
      bodyText = await response.text();
    } catch (err) {
      return { ok: false, error: `Failed to reach Replicate: ${err instanceof Error ? err.message : String(err)}` };
    }
    let data: ReplicatePrediction | undefined;
    try {
      data = JSON.parse(bodyText) as ReplicatePrediction;
    } catch {
      return { ok: false, error: `Replicate returned an unparseable response (HTTP ${response.status}).` };
    }
    if (!response.ok) return { ok: false, error: `Replicate API error (HTTP ${response.status})` };
    if (data.status === "succeeded") return { ok: true, prediction: data };
    if (data.status === "failed" || data.status === "canceled") return { ok: false, error: data.error ?? `Replicate prediction ${data.status}.` };
    if (Date.now() >= deadline) return { ok: false, error: `Timed out waiting for Replicate (still "${data.status}" after ${Math.round(timeoutMs / 1000)}s).` };
    await sleep(POLL_INTERVAL_MS);
  }
}

function extractOutputUrls(output: unknown): string[] {
  if (typeof output === "string") return [output];
  if (Array.isArray(output)) return output.filter((v): v is string => typeof v === "string");
  return [];
}

/** Creates a prediction for `model` with `input` (both passed straight through — see this module's own header comment on why), polls until it finishes, and returns the real output URL(s) — the caller decides what to do with them (this module doesn't download/save anything itself). */
export async function runReplicateModel(config: ReplicateConfig, model: string, input: Record<string, unknown>, timeoutMs = DEFAULT_POLL_TIMEOUT_MS, apiBaseUrl = REPLICATE_API_BASE): Promise<RunReplicateModelResult> {
  const created = await createPrediction(config, model, input, apiBaseUrl);
  if (!created.ok) return created;

  const getUrl = created.prediction.urls?.get ?? `${apiBaseUrl}/v1/predictions/${created.prediction.id}`;
  const finished = await pollPrediction(config, getUrl, timeoutMs);
  if (!finished.ok) return finished;

  const outputUrls = extractOutputUrls(finished.prediction.output);
  if (outputUrls.length === 0) return { ok: false, error: "Replicate's prediction succeeded but returned no output URL." };
  return { ok: true, outputUrls };
}

export type DownloadResult = { ok: true; bytes: Buffer } | { ok: false; error: string };

/** Downloads a real generated media file from its (typically pre-signed, no auth needed) output URL. */
export async function downloadReplicateOutput(url: string): Promise<DownloadResult> {
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, error: `Failed to download Replicate output (HTTP ${response.status}).` };
    return { ok: true, bytes: Buffer.from(await response.arrayBuffer()) };
  } catch (err) {
    return { ok: false, error: `Failed to download Replicate output: ${err instanceof Error ? err.message : String(err)}` };
  }
}
