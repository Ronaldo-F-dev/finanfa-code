import { spawn } from "node:child_process";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";
import { SHELL, killProcessGroup } from "../../util/process.js";
import { truncateOrSpill, TRUNCATE_MEDIUM } from "../../util/truncate.js";

function commandAvailable(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

interface TesseractRunResult {
  stdout: string;
  stderr: string;
  isError: boolean;
}

// Not runSubprocess: that helper always prefixes "(exit code N)" and shows
// labeled stdout/stderr sections, which is right for build/test/lint tool
// output but wrong here — the model wants the extracted text itself as the
// payload, not wrapped in that framing. tesseract itself keeps the two
// streams clean (verified directly: the actual text goes to stdout only,
// progress/diagnostic lines like "Estimating resolution as N" go to stderr
// only), so this only needs to surface stderr when something actually failed.
function runTesseract(args: string[], timeoutMs: number): Promise<TesseractRunResult> {
  return new Promise((resolve) => {
    const child = spawn("tesseract", args, { shell: SHELL, detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: timedOut ? `Timed out after ${timeoutMs}ms` : stderr, isError: timedOut || code !== 0 });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err.message, isError: true });
    });
  });
}

interface OcrImageInput {
  path: string;
  lang?: string;
}

export const ocrImageTool: ToolDefinition<OcrImageInput> = {
  name: "ocr_image",
  description:
    "Extract text from an image (PNG/JPEG/etc.) via Tesseract OCR — for a photo of a document, a screenshot " +
    "with text, or a scanned page. For a scanned PDF (no real text layer, so read_document returns nothing " +
    "useful), use convert_pdf_to_image first, then ocr_image on each rendered page. `lang` defaults to " +
    "\"eng\" and must be an installed Tesseract language pack (e.g. \"fra\" for French) — if it's missing, " +
    "tesseract reports that clearly rather than silently falling back to English; tell the user which pack to " +
    "install rather than trying to install it yourself.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Image file to run OCR on" },
      lang: { type: "string", description: 'Tesseract language code (default "eng")' },
    },
    required: ["path"],
  },
  describeCall: (input) => `ocr ${input.path}`,
  async handler(input, ctx) {
    if (!(await commandAvailable("tesseract", ["--version"]))) {
      return {
        content:
          "tesseract isn't available. Install it — `apt install tesseract-ocr` on Debian/Ubuntu, `brew " +
          "install tesseract` on macOS — then retry.",
        isError: true,
      };
    }

    const sourcePath = resolveAllowedPath(ctx.cwd, input.path);
    const result = await runTesseract([sourcePath, "stdout", "-l", input.lang ?? "eng"], 60_000);

    if (result.isError) {
      const errText = result.stderr.trim() || "tesseract failed with no output.";
      return { content: await truncateOrSpill(ctx.cwd, ctx.sessionId, "ocr-error", errText, TRUNCATE_MEDIUM), isError: true };
    }
    const text = result.stdout.trim();
    if (text.length === 0) {
      return { content: "No text detected in the image.", isError: false };
    }
    return { content: await truncateOrSpill(ctx.cwd, ctx.sessionId, "ocr", text, TRUNCATE_MEDIUM), isError: false };
  },
};
