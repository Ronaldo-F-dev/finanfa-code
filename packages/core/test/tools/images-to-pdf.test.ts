import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { imagesToPdfTool } from "../../src/tools/builtin/images-to-pdf.js";

async function makePng(dir: string, name: string, width: number, height: number): Promise<void> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .png()
    .toBuffer();
  await writeFile(path.join(dir, name), buffer);
}

async function makeJpeg(dir: string, name: string, width: number, height: number): Promise<void> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 0, g: 255, b: 0 } } })
    .jpeg()
    .toBuffer();
  await writeFile(path.join(dir, name), buffer);
}

describe("images_to_pdf tool (real pdf-lib image embedding)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-img2pdf-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("combines real PNG images into a real multi-page PDF, one page per image", async () => {
    await makePng(dir, "a.png", 200, 100);
    await makePng(dir, "b.png", 150, 300);

    const result = await imagesToPdfTool.handler({ paths: ["a.png", "b.png"], outputPath: "out.pdf" }, ctx());

    expect(result.isError).toBe(false);
    const doc = await PDFDocument.load(await readFile(path.join(dir, "out.pdf")));
    expect(doc.getPageCount()).toBe(2);
  });

  it("sizes each page to match its own image, no cropping/distortion", async () => {
    await makePng(dir, "wide.png", 400, 100);

    await imagesToPdfTool.handler({ paths: ["wide.png"], outputPath: "out.pdf" }, ctx());

    const doc = await PDFDocument.load(await readFile(path.join(dir, "out.pdf")));
    const page = doc.getPage(0);
    expect(page.getWidth()).toBe(400);
    expect(page.getHeight()).toBe(100);
  });

  it("supports mixed PNG and JPEG input", async () => {
    await makePng(dir, "a.png", 100, 100);
    await makeJpeg(dir, "b.jpg", 100, 100);

    const result = await imagesToPdfTool.handler({ paths: ["a.png", "b.jpg"], outputPath: "out.pdf" }, ctx());

    expect(result.isError).toBe(false);
    const doc = await PDFDocument.load(await readFile(path.join(dir, "out.pdf")));
    expect(doc.getPageCount()).toBe(2);
  });

  it("rejects an unsupported image format with a clear message", async () => {
    await writeFile(path.join(dir, "a.gif"), "not really a gif");
    const result = await imagesToPdfTool.handler({ paths: ["a.gif"], outputPath: "out.pdf" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported image format");
  });

  it("requires at least one image", async () => {
    const result = await imagesToPdfTool.handler({ paths: [], outputPath: "out.pdf" }, ctx());
    expect(result.isError).toBe(true);
  });
});
