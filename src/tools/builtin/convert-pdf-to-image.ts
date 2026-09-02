import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";
import { runSubprocess } from "../../util/process.js";

function commandAvailable(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

interface ConvertPdfToImageInput {
  path: string;
  outputPrefix?: string;
  page?: number;
  format?: "png" | "jpeg";
  dpi?: number;
}

function defaultPrefix(sourcePath: string): string {
  return sourcePath.replace(/\.[^./\\]+$/, "");
}

// pdftoppm's `-jpeg` flag writes files with a `.jpg` extension, not
// `.jpeg` — verified directly (`pdftoppm -jpeg ... prefix` produces
// `prefix.jpg`), not assumed from the flag name.
function outputExtension(format: "png" | "jpeg"): string {
  return format === "jpeg" ? "jpg" : "png";
}

export const convertPdfToImageTool: ToolDefinition<ConvertPdfToImageInput> = {
  name: "convert_pdf_to_image",
  description:
    "Render PDF pages to PNG/JPEG images, via poppler's `pdftoppm` (a real PDF rasterizer — headless Chromium " +
    "can't do this; navigating it to a PDF triggers a download instead of rendering one). Without `page`, " +
    "renders every page, named <prefix>-1.<ext>, <prefix>-2.<ext>, etc.; with `page`, renders just that one " +
    "page as <prefix>.<ext>. Needs pdftoppm installed (part of poppler-utils) — if it's missing, say so rather " +
    "than trying to install it yourself.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source .pdf file" },
      outputPrefix: { type: "string", description: "Output filename prefix, without extension (default: source path without .pdf)" },
      page: { type: "number", description: "Render only this 1-based page instead of every page" },
      format: { type: "string", enum: ["png", "jpeg"], description: 'Output format (default "png")' },
      dpi: { type: "number", description: "Resolution in DPI (default 150 — pdftoppm's own default)" },
    },
    required: ["path"],
  },
  riskKey: (input) => input.path,
  describeCall: (input) => `render ${input.path}${input.page ? ` page ${input.page}` : " (all pages)"} to ${input.format ?? "png"}`,
  async handler(input, ctx) {
    if (!(await commandAvailable("pdftoppm", ["-v"]))) {
      return {
        content:
          "pdftoppm isn't available (part of poppler-utils). Install it — `apt install poppler-utils` on " +
          "Debian/Ubuntu, `brew install poppler` on macOS — then retry.",
        isError: true,
      };
    }

    const sourcePath = resolveAllowedPath(ctx.cwd, input.path);
    const prefixInput = input.outputPrefix ?? defaultPrefix(input.path);
    const prefixPath = resolveAllowedPath(ctx.cwd, prefixInput);
    await mkdir(path.dirname(prefixPath), { recursive: true });

    const args = [`-${input.format ?? "png"}`, "-r", String(input.dpi ?? 150)];
    if (input.page !== undefined) args.push("-f", String(input.page), "-l", String(input.page), "-singlefile");
    args.push(sourcePath, prefixPath);

    const result = await runSubprocess("pdftoppm", { cwd: ctx.cwd, timeoutMs: 60_000, args });
    if (result.isError) return result;

    const prefixBase = path.basename(prefixPath);
    const ext = outputExtension(input.format ?? "png");
    // pdftoppm names output <prefix>-<N>.<ext> per page (N numeric, no
    // other separator), or exactly <prefix>.<ext> for -singlefile — matching
    // that precisely avoids picking up an unrelated pre-existing file that
    // merely happens to start with the same prefix.
    const pageNamePattern = new RegExp(`^${prefixBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+\\.${ext}$`);
    const created = (await readdir(path.dirname(prefixPath)))
      .filter((name) => name === `${prefixBase}.${ext}` || pageNamePattern.test(name))
      .sort()
      .map((name) => path.relative(ctx.cwd, path.join(path.dirname(prefixPath), name)));

    if (created.length === 0) {
      return { content: "pdftoppm ran without error but produced no output files — unexpected.", isError: true };
    }
    return { content: `Rendered ${created.length} page(s):\n${created.join("\n")}`, isError: false };
  },
};
