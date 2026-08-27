import type { ToolDefinition } from "../../core/types.js";
import { openUrl } from "../../util/open-url.js";
import { resolveAllowedPath } from "./path-guard.js";

interface PreviewHtmlInput {
  path: string;
}

export const previewHtmlTool: ToolDefinition<PreviewHtmlInput> = {
  name: "preview_html",
  description:
    "Open a local HTML file (e.g. a UI mockup written with write_file) in the user's default browser, so they can see it rendered.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the HTML file, relative to the project root" },
    },
    required: ["path"],
  },
  describeCall: (input) => `preview ${input.path}`,
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    openUrl(`file://${filePath}`);
    return { content: `Opened ${input.path} in the default browser.`, isError: false };
  },
};
