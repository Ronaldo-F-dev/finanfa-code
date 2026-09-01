import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { openUrl } from "../../util/open-url.js";
import { resolveAllowedPath } from "./path-guard.js";
import type { PreviewServer } from "../../core/preview-server.js";

interface PreviewHtmlInput {
  path: string;
}

export function createPreviewHtmlTool(server: PreviewServer): ToolDefinition<PreviewHtmlInput> {
  return {
    name: "preview_html",
    description:
      "Open a local HTML file (e.g. a UI mockup written with write_file) in the user's default browser, via a " +
      "real local HTTP server rooted at the project — not a bare file:// URL, so relative CSS/JS/image " +
      "references and fetch() calls in the page actually work. The server persists for the rest of the " +
      "session and is reused for later previews.",
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
      const relative = path.relative(ctx.cwd, filePath);
      const url = await server.urlFor(ctx.cwd, relative);
      openUrl(url);
      return { content: `Opened ${input.path} at ${url}`, isError: false };
    },
  };
}
