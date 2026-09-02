import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

interface ImagesToPdfInput {
  paths: string[];
  outputPath: string;
}

export const imagesToPdfTool: ToolDefinition<ImagesToPdfInput> = {
  name: "images_to_pdf",
  description:
    "Combine PNG/JPEG images into a single PDF, one image per page (in the given order), each page sized to " +
    "match its image so nothing is cropped or distorted. Other image formats aren't supported — convert with " +
    "resize_image first if needed.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "PNG/JPEG image files, in order" },
      outputPath: { type: "string", description: "Path for the output PDF" },
    },
    required: ["paths", "outputPath"],
  },
  riskKey: (input) => input.outputPath,
  describeCall: (input) => `combine ${input.paths.length} image(s) into ${input.outputPath}`,
  async handler(input, ctx) {
    if (input.paths.length === 0) return { content: "Need at least 1 image.", isError: true };

    const doc = await PDFDocument.create();
    for (const p of input.paths) {
      const srcPath = resolveAllowedPath(ctx.cwd, p);
      const ext = path.extname(srcPath).toLowerCase();
      const bytes = await readFile(srcPath);

      let embedded;
      if (ext === ".png") {
        embedded = await doc.embedPng(bytes);
      } else if (ext === ".jpg" || ext === ".jpeg") {
        embedded = await doc.embedJpg(bytes);
      } else {
        return { content: `Unsupported image format "${ext}" for ${p} — only .png and .jpg/.jpeg are supported.`, isError: true };
      }

      const page = doc.addPage([embedded.width, embedded.height]);
      page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    }

    const outputPath = resolveAllowedPath(ctx.cwd, input.outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, await doc.save());

    return { content: `Wrote ${input.paths.length} image(s) into ${input.outputPath}`, isError: false };
  },
};
