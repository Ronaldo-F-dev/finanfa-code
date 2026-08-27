import { readFile } from "node:fs/promises";
import type { ToolImage } from "../core/types.js";

/** A reasonable ceiling most vision-capable APIs accept without resizing. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function imageMimeTypeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return undefined;
  return MIME_BY_EXT[path.slice(dot).toLowerCase()];
}

export type ReadImageResult =
  | { ok: true; image: ToolImage }
  | { ok: false; error: string };

/** Reads an image file from disk into a base64 ToolImage, enforcing the size ceiling and a known mime type. */
export async function readImageFile(filePath: string, displayPath: string): Promise<ReadImageResult> {
  const mimeType = imageMimeTypeForPath(filePath);
  if (!mimeType) {
    return { ok: false, error: `Unsupported image type for "${displayPath}" (supported: png, jpg, jpeg, gif, webp)` };
  }
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (err) {
    return { ok: false, error: `Could not read "${displayPath}": ${err instanceof Error ? err.message : String(err)}` };
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    const mb = (buffer.length / 1024 / 1024).toFixed(1);
    return { ok: false, error: `Image too large (${mb} MB, max ${MAX_IMAGE_BYTES / 1024 / 1024} MB): ${displayPath}` };
  }
  return { ok: true, image: { mimeType, base64: buffer.toString("base64") } };
}
