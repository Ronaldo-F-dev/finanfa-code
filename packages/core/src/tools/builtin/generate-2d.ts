import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";
import { resolveAllowedPath } from "./path-guard.js";

// Real image generation via OpenAI's Images API (gpt-image-1) — reuses
// the same OPENAI_API_KEY transcribe_audio and recall_past_sessions'
// semantic mode already need, rather than a separate credential. This
// replaces an earlier honest stub: NVIDIA NIM lists free image models
// (FLUX.1-schnell/dev, Stable Diffusion 3.5) using the same free catalog
// this project's text/vision routing already relies on, but a real test
// call to its image endpoint never returned a response across three
// separate attempts (90s/150s/280s timeouts, TLS handshake and request
// upload both succeeding) — genuinely broken, not just untried, so it's
// not what this wraps. OpenAI's Images API is real, documented, and
// metered (a real cost per call, unlike the rest of this project's free
// image/vision tools) — riskLevel "ask" reflects that, plus the optional
// file write.
const OPENAI_API_BASE = "https://api.openai.com/v1";

export interface Generate2dConfig {
  apiKey: string;
}

export function generate2dConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Generate2dConfig | undefined {
  const apiKey = env.OPENAI_API_KEY;
  return apiKey ? { apiKey } : undefined;
}

export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";

export type GenerateImageResult = { ok: true; base64: string } | { ok: false; error: string };

interface OpenAiErrorBody {
  error?: { message?: string };
}

export async function generateImageOpenAi(config: Generate2dConfig, prompt: string, size: ImageSize | undefined, apiBaseUrl = OPENAI_API_BASE): Promise<GenerateImageResult> {
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(`${apiBaseUrl}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1", prompt, size: size ?? "1024x1024", n: 1 }),
    }));
  } catch (err) {
    return { ok: false, error: `Failed to reach OpenAI: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: (OpenAiErrorBody & { data?: { b64_json?: string }[] }) | undefined;
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    return { ok: false, error: `OpenAI returned an unparseable response (HTTP ${response.status}).` };
  }
  if (!response.ok) return { ok: false, error: data?.error?.message ?? `OpenAI API error (HTTP ${response.status})` };
  const base64 = data?.data?.[0]?.b64_json;
  if (!base64) return { ok: false, error: "OpenAI's response had no image data." };
  return { ok: true, base64 };
}

interface Generate2dInput {
  prompt: string;
  size?: ImageSize;
  output_path?: string;
}

export function createGenerate2dTool(config: Generate2dConfig | undefined, apiBaseUrl = OPENAI_API_BASE): ToolDefinition<Generate2dInput> {
  return {
    name: "generate_2d",
    description:
      "Generate a 2D image from a text description, via OpenAI's real Images API (gpt-image-1). Requires " +
      "OPENAI_API_KEY (the same key transcribe_audio/recall_past_sessions' semantic mode already use) — a " +
      "real, metered API call, not a free one. Shows you the generated image directly; pass output_path to " +
      "also save it as a PNG file. " +
      "IMPORTANT: this makes a real, billed API call — confirm the prompt with the user before calling this " +
      "unless they've explicitly asked for this exact image.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What image to generate" },
        size: { type: "string", enum: ["1024x1024", "1024x1536", "1536x1024"], description: 'Default "1024x1024"' },
        output_path: { type: "string", description: "If given, also saves the PNG here, relative to the project root" },
      },
      required: ["prompt"],
    },
    describeCall: (input) => `generate 2D image: ${input.prompt}`,
    async handler(input, ctx) {
      if (!config) {
        return {
          content:
            `2D image generation is unavailable — set OPENAI_API_KEY to enable it via OpenAI's real Images API ` +
            `(requested: "${input.prompt}"). NVIDIA NIM lists free FLUX/Stable Diffusion models, but that endpoint ` +
            "did not respond in real testing.",
          isError: true,
        };
      }
      const result = await generateImageOpenAi(config, input.prompt, input.size, apiBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };

      const images = [{ mimeType: "image/png", base64: result.base64 }];
      if (input.output_path) {
        const filePath = resolveAllowedPath(ctx.cwd, input.output_path);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, Buffer.from(result.base64, "base64"));
        return { content: `Generated image for "${input.prompt}", saved to ${input.output_path}.`, isError: false, images };
      }
      return { content: `Generated image for "${input.prompt}".`, isError: false, images };
    },
  };
}
