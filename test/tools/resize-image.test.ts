import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { resizeImageTool } from "../../src/tools/builtin/resize-image.js";

async function makeTestPng(dir: string, name: string, width: number, height: number): Promise<string> {
  const filePath = path.join(dir, name);
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  await sharp(buffer).toFile(filePath);
  return filePath;
}

describe("resize_image tool (real sharp execution)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-resize-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  it("resizes to an exact width and height with fit: cover", async () => {
    await makeTestPng(dir, "in.png", 200, 100);
    const result = await resizeImageTool.handler(
      { path: "in.png", outputPath: "out.png", width: 50, height: 50, fit: "cover" },
      ctx(),
    );
    expect(result.isError).toBe(false);

    const meta = await sharp(await readFile(path.join(dir, "out.png"))).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(50);
  });

  it("preserves aspect ratio when only width is given", async () => {
    await makeTestPng(dir, "in.png", 200, 100);
    await resizeImageTool.handler({ path: "in.png", outputPath: "out.png", width: 100 }, ctx());

    const meta = await sharp(await readFile(path.join(dir, "out.png"))).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(50);
  });

  it("default fit \"inside\" scales to fit within the box without cropping", async () => {
    await makeTestPng(dir, "in.png", 200, 100);
    // a 200x100 (2:1) image fit inside a 60x60 box stays 2:1 -> 60x30, not 60x60
    await resizeImageTool.handler({ path: "in.png", outputPath: "out.png", width: 60, height: 60 }, ctx());

    const meta = await sharp(await readFile(path.join(dir, "out.png"))).metadata();
    expect(meta.width).toBe(60);
    expect(meta.height).toBe(30);
  });

  it("overwrites the original file in place when outputPath is omitted", async () => {
    const filePath = await makeTestPng(dir, "in.png", 200, 100);
    const result = await resizeImageTool.handler({ path: "in.png", width: 50 }, ctx());
    expect(result.isError).toBe(false);

    const meta = await sharp(await readFile(filePath)).metadata();
    expect(meta.width).toBe(50);
  });

  it("converts format via the format option", async () => {
    await makeTestPng(dir, "in.png", 100, 100);
    await resizeImageTool.handler({ path: "in.png", outputPath: "out.webp", width: 50, format: "webp" }, ctx());

    const meta = await sharp(await readFile(path.join(dir, "out.webp"))).metadata();
    expect(meta.format).toBe("webp");
  });

  it("requires at least one of width or height", async () => {
    await makeTestPng(dir, "in.png", 100, 100);
    const result = await resizeImageTool.handler({ path: "in.png" }, ctx());
    expect(result.isError).toBe(true);
  });

  it("creates missing parent directories for outputPath, like write_file", async () => {
    await makeTestPng(dir, "in.png", 100, 100);
    const result = await resizeImageTool.handler(
      { path: "in.png", outputPath: "nested/dir/out.png", width: 50 },
      ctx(),
    );
    expect(result.isError).toBe(false);

    const meta = await sharp(await readFile(path.join(dir, "nested/dir/out.png"))).metadata();
    expect(meta.width).toBe(50);
  });
});
