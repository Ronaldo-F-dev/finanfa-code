import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readImageFile, imageMimeTypeForPath, MAX_IMAGE_BYTES } from "../../src/util/image.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("imageMimeTypeForPath", () => {
  it("maps known extensions, case-insensitively", () => {
    expect(imageMimeTypeForPath("a.png")).toBe("image/png");
    expect(imageMimeTypeForPath("a.JPG")).toBe("image/jpeg");
    expect(imageMimeTypeForPath("a.jpeg")).toBe("image/jpeg");
    expect(imageMimeTypeForPath("a.gif")).toBe("image/gif");
    expect(imageMimeTypeForPath("a.webp")).toBe("image/webp");
  });

  it("returns undefined for an unsupported or missing extension", () => {
    expect(imageMimeTypeForPath("a.bmp")).toBeUndefined();
    expect(imageMimeTypeForPath("noext")).toBeUndefined();
  });
});

describe("readImageFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-image-util-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a real file under the size ceiling successfully", async () => {
    const filePath = path.join(dir, "shot.png");
    await writeFile(filePath, ONE_PIXEL_PNG);

    const result = await readImageFile(filePath, "shot.png");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.image.mimeType).toBe("image/png");
      expect(Buffer.from(result.image.base64, "base64")).toEqual(ONE_PIXEL_PNG);
    }
  });

  it("rejects a real file over MAX_IMAGE_BYTES, without ever reaching the vision API path", async () => {
    const filePath = path.join(dir, "huge.png");
    await writeFile(filePath, Buffer.alloc(MAX_IMAGE_BYTES + 1));

    const result = await readImageFile(filePath, "huge.png");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("too large");
      expect(result.error).toContain(`${MAX_IMAGE_BYTES / 1024 / 1024}`);
    }
  });

  it("accepts a real file exactly at the size ceiling (boundary, not just over it)", async () => {
    const filePath = path.join(dir, "exact.png");
    await writeFile(filePath, Buffer.alloc(MAX_IMAGE_BYTES));

    const result = await readImageFile(filePath, "exact.png");
    expect(result.ok).toBe(true);
  });

  it("reports a clear error for an unsupported extension before ever touching the file", async () => {
    const result = await readImageFile(path.join(dir, "missing.bmp"), "missing.bmp");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unsupported image type");
  });

  it("reports a clear error when the file doesn't exist", async () => {
    const result = await readImageFile(path.join(dir, "nope.png"), "nope.png");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Could not read");
  });
});
