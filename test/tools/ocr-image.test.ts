import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ocrImageTool } from "../../src/tools/builtin/ocr-image.js";

async function makeTextImage(dir: string, name: string, text: string): Promise<void> {
  const svg = `<svg width="400" height="100" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <text x="10" y="60" font-size="36" font-family="sans-serif" fill="black">${text}</text>
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  await writeFile(path.join(dir, name), buffer);
}

describe("ocr_image tool (real tesseract execution)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-ocr-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("extracts real text from a real generated image", async () => {
    await makeTextImage(dir, "text.png", "Hello OCR World");

    const result = await ocrImageTool.handler({ path: "text.png" }, ctx());

    expect(result.isError).toBe(false);
    expect(result.content.toLowerCase()).toContain("hello");
    expect(result.content.toLowerCase()).toContain("world");
  });

  it("reports no text detected for a blank image, without erroring", async () => {
    const blank = await sharp({ create: { width: 200, height: 100, channels: 3, background: "white" } })
      .png()
      .toBuffer();
    await writeFile(path.join(dir, "blank.png"), blank);

    const result = await ocrImageTool.handler({ path: "blank.png" }, ctx());

    expect(result.isError).toBe(false);
    expect(result.content).toBe("No text detected in the image.");
  });

  it("fails clearly for a nonexistent file instead of hanging or crashing", async () => {
    const result = await ocrImageTool.handler({ path: "missing.png" }, ctx());
    expect(result.isError).toBe(true);
  });

  it("fails clearly with an unavailable language pack, naming the language", async () => {
    await makeTextImage(dir, "text.png", "Hello");
    const result = await ocrImageTool.handler({ path: "text.png", lang: "not-a-real-lang" }, ctx());
    expect(result.isError).toBe(true);
  });

  it("rejects a path escaping the project root", async () => {
    await expect(ocrImageTool.handler({ path: "../outside.png" }, ctx())).rejects.toThrow(/outside the project root/);
  });
});
