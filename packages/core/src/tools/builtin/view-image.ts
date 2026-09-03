import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";
import { readImageFile } from "../../util/image.js";

interface ViewImageInput {
  path: string;
}

export const viewImageTool: ToolDefinition<ViewImageInput> = {
  name: "view_image",
  description:
    "View an image file (PNG, JPEG, GIF, WebP) from the project — a screenshot, a mockup, a diagram, or an " +
    "image the user referenced. Shows you the actual image, not just its path.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the image file, relative to the project root" },
    },
    required: ["path"],
  },
  describeCall: (input) => `view ${input.path}`,
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const read = await readImageFile(filePath, input.path);
    if (!read.ok) {
      return { content: read.error, isError: true };
    }
    return { content: `Viewing ${input.path}`, isError: false, images: [read.image] };
  },
};
