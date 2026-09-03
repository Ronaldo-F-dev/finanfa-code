import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

interface SplitPdfInput {
  path: string;
  outputPrefix?: string;
  page?: number;
}

function defaultPrefix(sourcePath: string): string {
  return sourcePath.replace(/\.[^./\\]+$/, "");
}

export const splitPdfTool: ToolDefinition<SplitPdfInput> = {
  name: "split_pdf",
  description:
    "Split a PDF into separate single-page PDF files — the inverse of merge_pdf. Without `page`, writes one " +
    "file per page, named <prefix>-1.pdf, <prefix>-2.pdf, etc. (1-based); with `page`, writes just that one " +
    "page as <prefix>-<page>.pdf (always page-number-suffixed, even for a single page, so the default prefix " +
    "— the source path without .pdf — never collides with the source file itself). Without outputPrefix, uses " +
    "the source path without its .pdf extension.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source .pdf file" },
      outputPrefix: { type: "string", description: "Output filename prefix, without extension (default: source path without .pdf)" },
      page: { type: "number", description: "Extract only this 1-based page instead of every page" },
    },
    required: ["path"],
  },
  riskKey: (input) => input.path,
  describeCall: (input) => `split ${input.path}${input.page ? ` (page ${input.page})` : " (every page)"}`,
  async handler(input, ctx) {
    const sourcePath = resolveAllowedPath(ctx.cwd, input.path);
    const prefixInput = input.outputPrefix ?? defaultPrefix(input.path);
    const prefixPath = resolveAllowedPath(ctx.cwd, prefixInput);

    const src = await PDFDocument.load(await readFile(sourcePath));
    const pageCount = src.getPageCount();

    if (input.page !== undefined && (input.page < 1 || input.page > pageCount)) {
      return { content: `Page ${input.page} is out of range — ${input.path} has ${pageCount} page(s).`, isError: true };
    }

    const pageNumbers = input.page !== undefined ? [input.page] : Array.from({ length: pageCount }, (_, i) => i + 1);

    await mkdir(path.dirname(prefixPath), { recursive: true });
    const created: string[] = [];
    for (const pageNumber of pageNumbers) {
      const out = await PDFDocument.create();
      const [copied] = await out.copyPages(src, [pageNumber - 1]);
      out.addPage(copied);

      const destPath = `${prefixPath}-${pageNumber}.pdf`;
      await writeFile(destPath, await out.save());
      created.push(path.relative(ctx.cwd, destPath));
    }

    return { content: `Wrote ${created.length} file(s):\n${created.join("\n")}`, isError: false };
  },
};
