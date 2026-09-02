import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { convertPdfToImageTool } from "../../src/tools/builtin/convert-pdf-to-image.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function buildRealPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([300, 200]);
    page.drawRectangle({ x: 0, y: 0, width: 300, height: 200, color: rgb(i / pageCount, 0.5, 0.5) });
    page.drawText(`PAGE ${i}`, { x: 80, y: 90, size: 24, font });
  }
  return Buffer.from(await doc.save());
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("convert_pdf_to_image tool (real pdftoppm execution)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-pdf2img-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("renders every page of a real multi-page PDF to real PNG files", async () => {
    await writeFile(path.join(dir, "doc.pdf"), await buildRealPdf(3));

    const result = await convertPdfToImageTool.handler({ path: "doc.pdf" }, ctx());

    expect(result.isError).toBe(false);
    for (const n of [1, 2, 3]) {
      const bytes = await readFile(path.join(dir, `doc-${n}.png`));
      expect(bytes.subarray(0, 8)).toEqual(PNG_MAGIC);
    }
    expect(result.content).toContain("doc-1.png");
    expect(result.content).toContain("doc-3.png");
  });

  it("renders only the requested page as <prefix>.<ext>, with no page-number suffix", async () => {
    await writeFile(path.join(dir, "doc.pdf"), await buildRealPdf(3));

    const result = await convertPdfToImageTool.handler({ path: "doc.pdf", page: 2 }, ctx());

    expect(result.isError).toBe(false);
    const bytes = await readFile(path.join(dir, "doc.png"));
    expect(bytes.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(await exists(path.join(dir, "doc-1.png"))).toBe(false);
    expect(await exists(path.join(dir, "doc-2.png"))).toBe(false);
  });

  it("supports jpeg output and a custom outputPrefix", async () => {
    await writeFile(path.join(dir, "doc.pdf"), await buildRealPdf(1));

    const result = await convertPdfToImageTool.handler(
      { path: "doc.pdf", page: 1, format: "jpeg", outputPrefix: "shots/cover" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    // pdftoppm's -jpeg flag writes a .jpg extension, not .jpeg
    const bytes = await readFile(path.join(dir, "shots", "cover.jpg"));
    // JPEG magic number
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("does not pick up an unrelated pre-existing file that merely shares the prefix", async () => {
    await writeFile(path.join(dir, "doc.pdf"), await buildRealPdf(1));
    await writeFile(path.join(dir, "doc-old-backup.png"), "not a real png, just a decoy");

    const result = await convertPdfToImageTool.handler({ path: "doc.pdf" }, ctx());

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("doc-old-backup.png");
  });

  it("rejects a path escaping the project root, before running pdftoppm", async () => {
    await expect(
      convertPdfToImageTool.handler({ path: "../outside.pdf" }, ctx()),
    ).rejects.toThrow(/outside the project root/);
  });
});
