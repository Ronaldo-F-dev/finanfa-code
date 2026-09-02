import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

type ImageFormat = "png" | "jpeg" | "webp" | "gif";

interface ResizeImageInput {
  path: string;
  outputPath?: string;
  width?: number;
  height?: number;
  fit?: "inside" | "cover" | "contain" | "fill";
  format?: ImageFormat;
}

export const resizeImageTool: ToolDefinition<ResizeImageInput> = {
  name: "resize_image",
  description:
    "Resize and/or convert the format of an image (PNG/JPEG/WebP/GIF). Give width, height, or both to resize " +
    "— with only one, the other scales to preserve aspect ratio. With both and the default fit \"inside\", the " +
    "image scales to fit within that box without cropping or exceeding it (so the actual output size may " +
    "differ from what you asked for) — use fit \"cover\" if you specifically want an exact-size crop instead. " +
    "Give format alone with neither width nor height for a pure format conversion at the original size (e.g. " +
    "PNG to JPEG). Without outputPath, overwrites the original file.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the source image, relative to the project root or absolute" },
      outputPath: { type: "string", description: "Where to write the result (default: overwrite path)" },
      width: { type: "number" },
      height: { type: "number" },
      fit: {
        type: "string",
        enum: ["inside", "cover", "contain", "fill"],
        description: 'How to fit both dimensions when both are given (default "inside" — no cropping)',
      },
      format: { type: "string", enum: ["png", "jpeg", "webp", "gif"], description: "Convert to this format" },
    },
    required: ["path"],
  },
  riskKey: (input) => input.outputPath ?? input.path,
  describeCall: (input) => {
    const dims = [input.width, input.height].filter((n) => n !== undefined).join("x") || "(aspect-preserving)";
    const dest = input.outputPath ?? `${input.path} (overwrite)`;
    return `resize ${input.path} to ${dims} -> ${dest}`;
  },
  async handler(input, ctx) {
    if (input.width === undefined && input.height === undefined && !input.format) {
      return { content: "Give at least one of width, height, or format.", isError: true };
    }

    const sourcePath = resolveAllowedPath(ctx.cwd, input.path);
    const outputPath = resolveAllowedPath(ctx.cwd, input.outputPath ?? input.path);

    // sharp refuses to read and write the same file path in one pipeline
    // ("Cannot use same file for input and output") — reading fully into a
    // buffer first works for both the overwrite-in-place and separate-output
    // cases, with no special-casing needed.
    let pipeline = sharp(await readFile(sourcePath));
    if (input.width !== undefined || input.height !== undefined) {
      pipeline = pipeline.resize({
        width: input.width,
        height: input.height,
        fit: input.fit ?? "inside",
        withoutEnlargement: true,
      });
    }
    if (input.format) pipeline = pipeline.toFormat(input.format);

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, data);

    return {
      content: `Resized ${input.path} to ${info.width}x${info.height} (${info.format}) -> ${input.outputPath ?? input.path}`,
      isError: false,
    };
  },
};
