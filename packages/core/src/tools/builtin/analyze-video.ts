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
// Sent as inline_data (base64 in the request body), not Gemini's
// separate Files API: inline data is the real, documented path for a
// file under ~20MB in one request, and is far simpler/more verifiable
// than the Files API's multi-step resumable-upload protocol (initiate,
// get an upload URL back, PUT the bytes, finalize) — genuinely a
// different, larger integration to get right without a real account to
// test the exact wire behavior against. A video over the size ceiling
// is reported clearly as out of scope, not silently truncated or
// routed through an unverified upload flow.
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.0-flash";
const MAX_INLINE_VIDEO_BYTES = 19 * 1024 * 1024;

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

export async function analyzeVideoWithGemini(
  config: AnalyzeVideoConfig,
  videoBase64: string,
  mimeType: string,
  prompt: string,
  model = DEFAULT_MODEL,
  apiBaseUrl = GEMINI_API_BASE,
): Promise<AnalyzeVideoResult> {
  const url = `${apiBaseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: videoBase64 } }] }] }),
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
      `variable, independent of whichever provider is configured as the primary one. Limited to videos under ` +
      `${Math.floor(MAX_INLINE_VIDEO_BYTES / (1024 * 1024))}MB (sent inline in one request) — a larger file is ` +
      "reported as out of scope rather than silently failing.",
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
      if (size > MAX_INLINE_VIDEO_BYTES) {
        const mb = (size / (1024 * 1024)).toFixed(1);
        return { content: `"${input.path}" is ${mb}MB, over the ${Math.floor(MAX_INLINE_VIDEO_BYTES / (1024 * 1024))}MB limit for inline analysis.`, isError: true };
      }

      const buffer = await readFile(filePath);
      const result = await analyzeVideoWithGemini(config, buffer.toString("base64"), mimeType, input.prompt, input.model, apiBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: result.text, isError: false };
    },
  };
}
