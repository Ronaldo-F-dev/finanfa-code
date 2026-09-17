import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";
import { runReplicateModel, downloadReplicateOutput, type ReplicateConfig } from "../../core/replicate.js";

interface GenerateMediaInput {
  model: string;
  input: Record<string, unknown>;
  output_path: string;
  timeout_ms?: number;
}

function createGenerateMediaTool(kind: "video" | "music", config: ReplicateConfig | undefined, apiBaseUrl?: string): ToolDefinition<GenerateMediaInput> {
  return {
    name: `generate_${kind}`,
    description:
      `Generate ${kind} from a real Replicate model (e.g. ${kind === "video" ? '"minimax/video-01", "stability-ai/stable-video-diffusion"' : '"meta/musicgen", "stackadoo/stable-audio"'}) — ` +
      "pass the model's own real input fields as `input` (check the model's page on replicate.com for its exact schema; commonly includes `prompt`, sometimes `duration`/`seed`/etc. — this tool doesn't hardcode a fixed set of fields since every model's schema is different). " +
      "Requires REPLICATE_API_TOKEN as an environment variable, independent of whichever provider is configured as the primary one. " +
      `Saves the generated ${kind} to output_path. Generation is a real, billed, asynchronous job — this waits for it to finish (can take minutes) before returning. ` +
      "IMPORTANT: this makes a real, billed API call — confirm the model/prompt with the user before calling this unless they've explicitly asked for this exact generation.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: 'Replicate model in "owner/name" form' },
        input: { type: "object", description: "The model's own real input fields — see its page on replicate.com" },
        output_path: { type: "string", description: "Where to save the generated file, relative to the project root" },
        timeout_ms: { type: "number", description: "How long to wait for generation to finish (default 300000 = 5 minutes)" },
      },
      required: ["model", "input", "output_path"],
    },
    describeCall: (input) => `generate ${kind} with Replicate model "${input.model}"`,
    async handler(input, ctx) {
      if (!config) return { content: `generate_${kind} is not configured — set REPLICATE_API_TOKEN as an environment variable to enable it.`, isError: true };

      // Validated before spending anything on a real, billed generation —
      // an invalid output_path should never be discovered only after
      // paying for the job.
      const filePath = resolveAllowedPath(ctx.cwd, input.output_path);

      const result = await runReplicateModel(config, input.model, input.input, input.timeout_ms, apiBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };

      const download = await downloadReplicateOutput(result.outputUrls[0]!);
      if (!download.ok) return { content: download.error, isError: true };

      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, download.bytes);
      return { content: `Generated ${kind} saved to ${input.output_path} (${result.outputUrls.length} output(s) total; the rest: ${result.outputUrls.slice(1).join(", ") || "none"}).`, isError: false };
    },
  };
}

export function createGenerateVideoTool(config: ReplicateConfig | undefined, apiBaseUrl?: string): ToolDefinition<GenerateMediaInput> {
  return createGenerateMediaTool("video", config, apiBaseUrl);
}

export function createGenerateMusicTool(config: ReplicateConfig | undefined, apiBaseUrl?: string): ToolDefinition<GenerateMediaInput> {
  return createGenerateMediaTool("music", config, apiBaseUrl);
}
