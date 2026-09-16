import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

// Speech-to-text via OpenAI's Whisper transcription API — the counterpart
// to text_to_speech.ts's free Google Translate backend, but there's no
// equivalent free/keyless STT service; this needs its own OPENAI_API_KEY,
// independent of whatever the primary chat provider is (same reasoning as
// send_slack_message needing its own bot token regardless of provider).
export interface TranscribeAudioConfig {
  apiKey: string;
}

export function transcribeAudioConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TranscribeAudioConfig | undefined {
  const apiKey = env.OPENAI_API_KEY;
  return apiKey ? { apiKey } : undefined;
}

interface TranscribeAudioInput {
  audioPath: string;
  /** ISO-639-1 language hint (e.g. "en", "fr") — improves accuracy but isn't required; Whisper auto-detects otherwise. */
  language?: string;
}

interface WhisperResponse {
  text?: string;
}

interface WhisperErrorResponse {
  error?: { message?: string };
}

const AUDIO_MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".mp4": "audio/mp4",
  ".mpeg": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
};

export function createTranscribeAudioTool(config: TranscribeAudioConfig | undefined, apiBaseUrl = "https://api.openai.com/v1"): ToolDefinition<TranscribeAudioInput> {
  return {
    name: "transcribe_audio",
    description:
      "Transcribe a real audio file (mp3/mp4/mpeg/m4a/wav/webm/ogg/flac) to text, via OpenAI's Whisper API. " +
      "Requires OPENAI_API_KEY as an environment variable, independent of whichever provider is configured for " +
      "the chat model itself — this tool never takes credentials as input.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        audioPath: { type: "string", description: "Path to the audio file to transcribe" },
        language: { type: "string", description: 'Optional ISO-639-1 language hint, e.g. "en" — improves accuracy but is not required' },
      },
      required: ["audioPath"],
    },
    describeCall: (input) => `transcribe audio: ${input.audioPath}`,
    async handler(input, ctx) {
      if (!config) {
        return { content: "transcribe_audio is not configured — set OPENAI_API_KEY as an environment variable to enable it.", isError: true };
      }

      const audioPath = resolveAllowedPath(ctx.cwd, input.audioPath);
      const ext = path.extname(audioPath).toLowerCase();
      const mimeType = AUDIO_MIME_TYPES[ext];
      if (!mimeType) {
        return { content: `Unsupported audio format "${ext || "(none)"}" — supported: ${Object.keys(AUDIO_MIME_TYPES).join(", ")}.`, isError: true };
      }

      try {
        await stat(audioPath);
      } catch {
        return { content: `No such file: ${input.audioPath}`, isError: true };
      }

      const bytes = await readFile(audioPath);
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mimeType }), path.basename(audioPath));
      form.append("model", "whisper-1");
      if (input.language) form.append("language", input.language);

      let response: Response;
      try {
        response = await fetch(`${apiBaseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.apiKey}` },
          body: form,
        });
      } catch (err) {
        return { content: `Failed to reach OpenAI: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const data = (await response.json()) as WhisperErrorResponse;
          if (data.error?.message) message = data.error.message;
        } catch {
          // Non-JSON error body — fall through with the plain status.
        }
        return { content: `Transcription failed: ${message}`, isError: true };
      }

      const data = (await response.json()) as WhisperResponse;
      if (typeof data.text !== "string") {
        return { content: "OpenAI returned an unexpected response shape (no transcript text).", isError: true };
      }
      return { content: data.text, isError: false };
    },
  };
}
