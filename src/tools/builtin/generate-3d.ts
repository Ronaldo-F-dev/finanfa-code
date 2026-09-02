import type { ToolDefinition } from "../../core/types.js";

interface Generate3dInput {
  prompt: string;
}

/**
 * Stub — no image-to-3D provider is wired in. SAM 3D and TRELLIS both need
 * 24-32GB of VRAM to self-host, well beyond what's practical here, and no
 * paid API (e.g. fal.ai) has been configured. Kept as a real tool (not just
 * a system-prompt note) so the model gets a clear, consistent "unavailable"
 * result instead of guessing at a workaround.
 */
export const generate3dTool: ToolDefinition<Generate3dInput> = {
  name: "generate_3d",
  description:
    "Generate a 3D model/asset from a text description. NOT CURRENTLY AVAILABLE — no image-to-3D provider is " +
    "configured (SAM 3D and TRELLIS both need 24-32GB of VRAM to self-host; no paid API like fal.ai is wired " +
    "in). Always returns unavailable — tell the user 3D generation isn't supported yet rather than attempting " +
    "a workaround.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What 3D asset was requested" },
    },
    required: ["prompt"],
  },
  describeCall: (input) => `generate 3D: ${input.prompt}`,
  async handler(input) {
    return {
      content:
        `3D generation is unavailable — no image-to-3D provider is configured (requested: "${input.prompt}"). ` +
        "SAM 3D and TRELLIS both require 24-32GB of VRAM to self-host, and no paid API (e.g. fal.ai) is wired in yet.",
      isError: true,
    };
  },
};
