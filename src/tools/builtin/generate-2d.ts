import type { ToolDefinition } from "../../core/types.js";

interface Generate2dInput {
  prompt: string;
}

/**
 * Stub — NVIDIA NIM lists FLUX.1-schnell/dev and Stable Diffusion 3.5 as
 * free image-generation models (same free catalog already used for text/
 * vision), but a real test call to
 * https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell
 * never returned a response — zero bytes received across three attempts
 * (90s/150s/280s timeouts, TLS handshake and request upload both
 * succeeding). Shipping a tool that can hang a tool call indefinitely is
 * worse than admitting it doesn't work; revisit if NIM's image endpoints
 * become reliable, or a different free provider is found.
 */
export const generate2dTool: ToolDefinition<Generate2dInput> = {
  name: "generate_2d",
  description:
    "Generate a 2D image from a text description. NOT CURRENTLY AVAILABLE — NVIDIA NIM lists free image models " +
    "(FLUX, Stable Diffusion 3.5) but the actual endpoint did not respond in real testing (not just untried). " +
    "Always returns unavailable — tell the user image generation isn't supported yet rather than attempting a workaround.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What image was requested" },
    },
    required: ["prompt"],
  },
  describeCall: (input) => `generate 2D: ${input.prompt}`,
  async handler(input) {
    return {
      content:
        `2D image generation is unavailable — no working provider is configured (requested: "${input.prompt}"). ` +
        "NVIDIA NIM lists free FLUX/Stable Diffusion models, but the endpoint did not respond in real testing.",
      isError: true,
    };
  },
};
