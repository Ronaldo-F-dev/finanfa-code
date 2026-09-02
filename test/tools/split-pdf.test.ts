import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { splitPdfTool } from "../../src/tools/builtin/split-pdf.js";

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

describe("split_pdf tool (real pdf-lib page extraction)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-split-pdf-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("splits every page of a real multi-page PDF into separate single-page PDFs", async () => {
    await writeFile(path.join(dir, "doc.pdf"), await buildRealPdf(3));

    const result = await splitPdfTool.handler({ path: "doc.pdf" }, ctx());

    expect(result.isError).toBe(false);
    for (const n of [1, 2, 3]) {
      const bytes = await readFile(path.join(dir, `doc-${n}.pdf`));
      const single = await PDFDocument.load(bytes);
      expect(single.getPageCount()).toBe(1);
    }
  });

  it("extracts only the requested page, page-number-suffixed so it never collides with the source file", async () => {
    await writeFile(path.join(dir, "doc.pdf"), await buildRealPdf(3));

    const result = await splitPdfTool.handler({ path: "doc.pdf", page: 2 }, ctx());

    expect(result.isError).toBe(false);
    const single = await PDFDocument.load(await readFile(path.join(dir, "doc-2.pdf")));
    expect(single.getPageCount()).toBe(1);
    expect(await exists(path.join(dir, "doc-1.pdf"))).toBe(false);
    expect(await exists(path.join(dir, "doc-3.pdf"))).toBe(false);

    // the source file itself must survive untouched, not get overwritten
    const source = await PDFDocument.load(await readFile(path.join(dir, "doc.pdf")));
    expect(source.getPageCount()).toBe(3);
  });

  it("rejects an out-of-range page with a clear message", async () => {
    await writeFile(path.join(dir, "doc.pdf"), await buildRealPdf(2));
    const result = await splitPdfTool.handler({ path: "doc.pdf", page: 5 }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("2 page(s)");
  });

  it("respects a custom outputPrefix", async () => {
    await writeFile(path.join(dir, "doc.pdf"), await buildRealPdf(1));
    const result = await splitPdfTool.handler({ path: "doc.pdf", outputPrefix: "pages/p" }, ctx());
    expect(result.isError).toBe(false);
    expect(await exists(path.join(dir, "pages", "p-1.pdf"))).toBe(true);
  });
});
