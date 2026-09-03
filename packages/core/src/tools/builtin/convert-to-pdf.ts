import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Marked } from "marked";
import mammoth from "mammoth";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";
import type { BrowserManager } from "../../browser/manager.js";

interface ConvertToPdfInput {
  path: string;
  outputPath?: string;
}

// A separate Marked instance, not the shared default export — src/ui/markdown.ts
// mutates that shared instance with marked-terminal's ANSI renderer the first
// time the CLI renders any assistant markdown, which would otherwise turn this
// tool's HTML output into terminal escape codes instead.
const htmlMarked = new Marked();

const PAGE_STYLE = `
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; }
  h1, h2, h3 { line-height: 1.3; }
  code, pre { font-family: "SF Mono", Consolas, monospace; }
  pre { background: #f4f4f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
  code { background: #f4f4f5; padding: 1px 4px; border-radius: 3px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
  img { max-width: 100%; }
`;

function wrapHtml(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_STYLE}</style></head><body>${bodyHtml}</body></html>`;
}

async function toHtml(sourcePath: string, buffer: Buffer): Promise<string> {
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === ".md" || ext === ".markdown") {
    return wrapHtml(await htmlMarked.parse(buffer.toString("utf-8")));
  }
  if (ext === ".html" || ext === ".htm") {
    return buffer.toString("utf-8");
  }
  if (ext === ".docx") {
    const result = await mammoth.convertToHtml({ buffer });
    return wrapHtml(result.value);
  }
  throw new Error(`Unsupported source format "${ext}" — convert_to_pdf handles .md/.markdown, .html/.htm, and .docx.`);
}

function defaultOutputPath(sourcePath: string): string {
  return sourcePath.replace(/\.[^./\\]+$/, "") + ".pdf";
}

export function createConvertToPdfTool(browser: BrowserManager): ToolDefinition<ConvertToPdfInput> {
  return {
    name: "convert_to_pdf",
    description:
      "Convert a Markdown (.md), HTML (.html), or Word (.docx) file to PDF, rendered through a real headless " +
      "browser (so Markdown tables/code blocks and .docx formatting come through, not just plain text). " +
      "Without outputPath, writes next to the source with the same name and a .pdf extension.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Source file: .md/.markdown, .html/.htm, or .docx" },
        outputPath: { type: "string", description: "Where to write the PDF (default: source path with .pdf instead)" },
      },
      required: ["path"],
    },
    riskKey: (input) => input.outputPath ?? input.path,
    describeCall: (input) => `convert ${input.path} -> ${input.outputPath ?? defaultOutputPath(input.path)}`,
    async handler(input, ctx) {
      const sourcePath = resolveAllowedPath(ctx.cwd, input.path);
      const destPath = resolveAllowedPath(ctx.cwd, input.outputPath ?? defaultOutputPath(input.path));

      let html: string;
      try {
        html = await toHtml(sourcePath, await readFile(sourcePath));
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }

      await mkdir(path.dirname(destPath), { recursive: true });
      await browser.printHtmlToPdf(html, destPath);

      return {
        content: `Converted ${input.path} -> ${path.relative(ctx.cwd, destPath)}`,
        isError: false,
      };
    },
  };
}
