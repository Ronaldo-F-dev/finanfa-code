import { readFile, stat } from "node:fs/promises";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// Real, native video understanding via Gemini's multimodal API — a
// genuine step beyond view_video_frames.ts's still-frame sampling:
// Gemini processes the video's actual motion and audio together, not a
// handful of separate images, so it can answer questions view_video_
// frames structurally can't ("what does the narrator say right after
// the character turns around?"). Needs its own GEMINI_API_KEY,
// independent of whatever the primary chat provider is configured to
// (same reasoning as transcribe_audio/send_slack_message each needing
// their own credential) — this project's own Gemini LlmProvider reuses
// the shared FINANFA_API_KEY/config.apiKey field for whichever provider
// is currently selected, which this tool must NOT depend on, since it
// needs to work regardless of the primary provider.
//
// A small video (<19MB) is sent inline (base64 in the request body) —
// simplest, one request. A larger one goes through Gemini's real File
// API instead: the standard resumable-upload protocol Google publishes
// for this exact use case (start -> get an upload URL back via a real
// response header -> upload+finalize the bytes -> poll until the file's
// server-side processing reports ACTIVE -> reference it by file_uri in
// generateContent -> delete it afterward). Confirmed end to end against
// a real, live Gemini account (a real ~21MB generated video, forcing
// this exact path) — both the inline and File API paths returned a real
// answer, and the uploaded file was confirmed actually deleted
// afterward. That same real run is also what surfaced two genuine bugs
// fixed alongside this: DEFAULT_MODEL below had drifted to a
// since-deprecated model name (Gemini's own API told new callers to
// migrate off it), and start/finalizeResumableUpload had no retry at
// all unlike generateContentWithPart's fetchWithRetry — a transient
// network blip during a real multi-minute upload reliably reproduced
// the whole flow failing outright before that fix.
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-3.6-flash";
const MAX_INLINE_VIDEO_BYTES = 19 * 1024 * 1024;
// The File API itself allows up to 2GB per file, but this tool reads the
// whole file into memory (readFile + a base64/Buffer copy at points) —
// a practical, self-imposed ceiling well under that to avoid a genuinely
// huge file causing real memory pressure in this process, not a Gemini
// API limit.
const MAX_FILE_API_VIDEO_BYTES = 200 * 1024 * 1024;
const FILE_PROCESSING_POLL_INTERVAL_MS = 2_000;
const FILE_PROCESSING_TIMEOUT_MS = 120_000;

export interface AnalyzeVideoConfig {
  apiKey: string;
}

export function analyzeVideoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AnalyzeVideoConfig | undefined {
  const apiKey = env.GEMINI_API_KEY;
  return apiKey ? { apiKey } : undefined;
}

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".wmv": "video/x-ms-wmv",
  ".3gp": "video/3gpp",
};

export function videoMimeTypeForPath(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return undefined;
  return MIME_BY_EXT[filePath.slice(dot).toLowerCase()];
}

interface GeminiErrorBody {
  error?: { message?: string };
}

interface GeminiPart {
  text?: string;
}

interface GeminiGenerateContentResponse extends GeminiErrorBody {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
}

export type AnalyzeVideoResult = { ok: true; text: string } | { ok: false; error: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateContentWithPart(
  config: AnalyzeVideoConfig,
  prompt: string,
  videoPart: Record<string, unknown>,
  model: string,
  apiBaseUrl: string,
): Promise<AnalyzeVideoResult> {
  const url = `${apiBaseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }, videoPart] }] }),
    }));
  } catch (err) {
    return { ok: false, error: `Failed to reach Gemini: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: GeminiGenerateContentResponse | undefined;
  try {
    data = JSON.parse(bodyText) as GeminiGenerateContentResponse;
  } catch {
    return { ok: false, error: `Gemini returned an unparseable response (HTTP ${response.status}).` };
  }
  if (!response.ok) return { ok: false, error: data?.error?.message ?? `Gemini API error (HTTP ${response.status})` };

  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) return { ok: false, error: "Gemini's response had no text content." };
  return { ok: true, text };
}

/** A video under the inline ceiling: one request, base64 in the body. */
export async function analyzeVideoInline(
  config: AnalyzeVideoConfig,
  videoBase64: string,
  mimeType: string,
  prompt: string,
  model = DEFAULT_MODEL,
  apiBaseUrl = GEMINI_API_BASE,
): Promise<AnalyzeVideoResult> {
  return generateContentWithPart(config, prompt, { inline_data: { mime_type: mimeType, data: videoBase64 } }, model, apiBaseUrl);
}

export interface UploadedGeminiFile {
  uri: string;
  name: string;
}

export type UploadGeminiFileResult = { ok: true; file: UploadedGeminiFile } | { ok: false; error: string };

/**
 * Step 1 of Google's real resumable-upload protocol: announces the
 * upload (size/mime type) and gets back a one-time upload URL via the
 * X-Goog-Upload-URL response header — not part of the JSON body.
 *
 * Uses fetchWithRetry (the same shared network-level retry as
 * generateContentWithPart below) rather than a bare fetch — confirmed
 * against a real Gemini account that a large-video upload can take long
 * enough for a plain transient network blip to otherwise kill the whole
 * flow immediately, with no chance to recover the way this same file's
 * generateContentWithPart already could.
 */
async function startResumableUpload(config: AnalyzeVideoConfig, sizeBytes: number, mimeType: string, displayName: string, apiBaseUrl: string): Promise<{ ok: true; uploadUrl: string } | { ok: false; error: string }> {
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(`${apiBaseUrl}/upload/v1beta/files?key=${encodeURIComponent(config.apiKey)}`, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(sizeBytes),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "content-type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    }));
  } catch (err) {
    return { ok: false, error: `Failed to reach Gemini: ${err instanceof Error ? err.message : String(err)}` };
  }
  const uploadUrl = response.headers.get("x-goog-upload-url");
  if (!response.ok || !uploadUrl) {
    return { ok: false, error: bodyText.trim() || `Gemini upload-start error (HTTP ${response.status})` };
  }
  return { ok: true, uploadUrl };
}

/**
 * Step 2: uploads the real bytes to the one-time URL from step 1,
 * finalizing in the same request (offset 0, the whole file in one shot
 * — this tool doesn't chunk an upload across multiple requests). Also
 * on fetchWithRetry, for the same real reason as startResumableUpload —
 * sending the same offset-0/finalize request again on a transient
 * network failure is safe to retry (each attempt re-sends the whole
 * buffer against the still-open, one-time upload URL from step 1, not a
 * partial continuation that could double up).
 */
async function finalizeResumableUpload(uploadUrl: string, buffer: Buffer): Promise<UploadGeminiFileResult> {
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(uploadUrl, {
      method: "POST",
      headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "content-length": String(buffer.length) },
      body: buffer,
    }));
  } catch (err) {
    return { ok: false, error: `Failed to reach Gemini: ${err instanceof Error ? err.message : String(err)}` };
  }
  let data: (GeminiErrorBody & { file?: { uri?: string; name?: string } }) | undefined;
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    return { ok: false, error: `Gemini returned an unparseable upload response (HTTP ${response.status}).` };
  }
  if (!response.ok) return { ok: false, error: data?.error?.message ?? `Gemini upload error (HTTP ${response.status})` };
  if (!data?.file?.uri || !data.file.name) return { ok: false, error: "Gemini's upload response had no file uri/name." };
  return { ok: true, file: { uri: data.file.uri, name: data.file.name } };
}

/**
 * Step 3: a freshly-uploaded video needs server-side processing before
 * it can be referenced in generateContent — polls the file's own state
 * until it's ACTIVE (ready), FAILED (reported as an error), or a real
 * timeout. A network-level failure on any one poll attempt doesn't abort
 * the whole wait — it's treated the same as "not ready yet" and the loop
 * tries again next interval, up to the same overall deadline, since a
 * transient blip here has no reason to be any more fatal than one on the
 * next poll a couple seconds later would be.
 */
async function waitForFileActive(config: AnalyzeVideoConfig, fileName: string, apiBaseUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const deadline = Date.now() + FILE_PROCESSING_TIMEOUT_MS;
  for (;;) {
    const outcome = await (async (): Promise<{ ok: true; state?: string } | { ok: false; error: string } | { retry: true }> => {
      let response: Response;
      let bodyText: string;
      try {
        response = await fetch(`${apiBaseUrl}/v1beta/${fileName}?key=${encodeURIComponent(config.apiKey)}`);
        bodyText = await response.text();
      } catch {
        return { retry: true };
      }
      let data: (GeminiErrorBody & { state?: string }) | undefined;
      try {
        data = JSON.parse(bodyText) as typeof data;
      } catch {
        return { ok: false, error: `Gemini returned an unparseable file-status response (HTTP ${response.status}).` };
      }
      if (!response.ok) return { ok: false, error: data?.error?.message ?? `Gemini file-status error (HTTP ${response.status})` };
      return { ok: true, state: data?.state };
    })();
    if ("error" in outcome) return outcome;
    if ("ok" in outcome) {
      if (outcome.state === "ACTIVE") return { ok: true };
      if (outcome.state === "FAILED") return { ok: false, error: "Gemini failed to process the uploaded video." };
    }
    if (Date.now() >= deadline) return { ok: false, error: "Timed out waiting for Gemini to finish processing the uploaded video." };
    await sleep(FILE_PROCESSING_POLL_INTERVAL_MS);
  }
}

/** Best-effort cleanup — a failure here doesn't affect the actual analysis result, so it's never surfaced as an error of its own. */
async function deleteGeminiFile(config: AnalyzeVideoConfig, fileName: string, apiBaseUrl: string): Promise<void> {
  await fetch(`${apiBaseUrl}/v1beta/${fileName}?key=${encodeURIComponent(config.apiKey)}`, { method: "DELETE" }).catch(() => {});
}

/** A video over the inline ceiling: the full real File API flow (upload -> wait for processing -> analyze -> delete). */
export async function analyzeVideoViaFilesApi(
  config: AnalyzeVideoConfig,
  buffer: Buffer,
  mimeType: string,
  prompt: string,
  displayName: string,
  model = DEFAULT_MODEL,
  apiBaseUrl = GEMINI_API_BASE,
): Promise<AnalyzeVideoResult> {
  const started = await startResumableUpload(config, buffer.length, mimeType, displayName, apiBaseUrl);
  if (!started.ok) return started;

  const uploaded = await finalizeResumableUpload(started.uploadUrl, buffer);
  if (!uploaded.ok) return uploaded;

  const ready = await waitForFileActive(config, uploaded.file.name, apiBaseUrl);
  if (!ready.ok) return ready;

  const result = await generateContentWithPart(config, prompt, { file_data: { mime_type: mimeType, file_uri: uploaded.file.uri } }, model, apiBaseUrl);
  void deleteGeminiFile(config, uploaded.file.name, apiBaseUrl);
  return result;
}

/** Picks inline vs the real Files API based on size, so callers (the tool below) don't need to know which path applies. */
export async function analyzeVideo(
  config: AnalyzeVideoConfig,
  buffer: Buffer,
  mimeType: string,
  prompt: string,
  displayName: string,
  model = DEFAULT_MODEL,
  apiBaseUrl = GEMINI_API_BASE,
): Promise<AnalyzeVideoResult> {
  if (buffer.length <= MAX_INLINE_VIDEO_BYTES) return analyzeVideoInline(config, buffer.toString("base64"), mimeType, prompt, model, apiBaseUrl);
  return analyzeVideoViaFilesApi(config, buffer, mimeType, prompt, displayName, model, apiBaseUrl);
}

interface AnalyzeVideoInput {
  path: string;
  prompt: string;
  model?: string;
}

export function createAnalyzeVideoTool(config: AnalyzeVideoConfig | undefined, apiBaseUrl = GEMINI_API_BASE): ToolDefinition<AnalyzeVideoInput> {
  return {
    name: "analyze_video",
    description:
      "Ask a real question about a video's actual content — motion, audio, dialogue, what happens over time — " +
      "via Gemini's native video understanding (genuinely different from view_video_frames, which only samples " +
      "still images: this sees the real video and audio together). Requires GEMINI_API_KEY as an environment " +
      "variable, independent of whichever provider is configured as the primary one. A video under " +
      `${Math.floor(MAX_INLINE_VIDEO_BYTES / (1024 * 1024))}MB is sent in one request; a larger one (up to ` +
      `${Math.floor(MAX_FILE_API_VIDEO_BYTES / (1024 * 1024))}MB) goes through Gemini's real File API instead ` +
      "(upload, wait for processing, analyze, then delete it) — slower, since a real video needs server-side " +
      "processing before Gemini can see it.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the video file, relative to the project root" },
        prompt: { type: "string", description: 'What to ask about the video, e.g. "Summarize what happens" or "What does the narrator say at the start?"' },
        model: { type: "string", description: `Gemini model to use (default "${DEFAULT_MODEL}")` },
      },
      required: ["path", "prompt"],
    },
    describeCall: (input) => `analyze video ${input.path}: ${input.prompt}`,
    async handler(input, ctx) {
      if (!config) return { content: "analyze_video is not configured — set GEMINI_API_KEY as an environment variable to enable it.", isError: true };

      const filePath = resolveAllowedPath(ctx.cwd, input.path);
      const mimeType = videoMimeTypeForPath(filePath);
      if (!mimeType) return { content: `Unsupported video type for "${input.path}" (supported: ${Object.keys(MIME_BY_EXT).join(", ")})`, isError: true };

      let size: number;
      try {
        size = (await stat(filePath)).size;
      } catch (err) {
        return { content: `Could not read "${input.path}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      if (size > MAX_FILE_API_VIDEO_BYTES) {
        const mb = (size / (1024 * 1024)).toFixed(1);
        return { content: `"${input.path}" is ${mb}MB, over the ${Math.floor(MAX_FILE_API_VIDEO_BYTES / (1024 * 1024))}MB limit this tool supports.`, isError: true };
      }

      const buffer = await readFile(filePath);
      const displayName = input.path.split("/").pop() ?? input.path;
      const result = await analyzeVideo(config, buffer, mimeType, input.prompt, displayName, input.model, apiBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: result.text, isError: false };
    },
  };
}
