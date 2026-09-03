import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const sampleDocFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/sample.doc");
import { Document, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  readDocumentTool,
  writeSpreadsheetTool,
  editSpreadsheetTool,
  mergeSpreadsheetsTool,
  mergePdfTool,
  writeDocumentTool,
  editDocumentTool,
} from "../../src/tools/builtin/documents.js";

async function buildRealPdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 20, y: 150, size: 14, font });
  return Buffer.from(await doc.save());
}

async function buildDocxWithParagraphs(paragraphs: string[][]): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: paragraphs.map((runs) => new Paragraph({ children: runs.map((text) => new TextRun(text)) })),
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/**
 * Hand-rolled minimal single-page PDF with a real text-drawing content
 * stream, so tests exercise pdf-parse against real PDF bytes rather than a
 * mock. Font size/page size are kept modest — a large font size near a tight
 * MediaBox was observed to clip the last few extracted characters.
 */
function buildMinimalPdf(text: string): Buffer {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] =
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 400 200] /Contents 5 0 R >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const stream = `BT /F1 12 Tf 10 100 Td (${text}) Tj ET`;
  objs[5] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

describe("document tools (real files, real libraries)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-documents-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  describe("read_document", () => {
    it("extracts text from a real PDF", async () => {
      await writeFile(path.join(dir, "sample.pdf"), buildMinimalPdf("Hello real PDF fixture"));
      const result = await readDocumentTool.handler({ path: "sample.pdf" }, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Hello real PDF fixture");
    });

    it("reports no extractable text layer for a PDF with an empty content stream", async () => {
      await writeFile(path.join(dir, "blank.pdf"), buildMinimalPdf(""));
      const result = await readDocumentTool.handler({ path: "blank.pdf" }, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toMatch(/no extractable text/i);
    });

    it("extracts text from a real .docx file (generated with the docx package)", async () => {
      const doc = new Document({
        sections: [
          {
            children: [
              new Paragraph({ children: [new TextRun("First paragraph.")] }),
              new Paragraph({ children: [new TextRun("Second paragraph.")] }),
            ],
          },
        ],
      });
      await writeFile(path.join(dir, "sample.docx"), await Packer.toBuffer(doc));

      const result = await readDocumentTool.handler({ path: "sample.docx" }, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("First paragraph.");
      expect(result.content).toContain("Second paragraph.");
    });

    it("extracts text from a real .xlsx file (generated with exceljs)", async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Scores");
      sheet.addRow(["Name", "Score"]);
      sheet.addRow(["Alice", 90]);
      await writeFile(path.join(dir, "sample.xlsx"), (await workbook.xlsx.writeBuffer()) as unknown as Buffer);

      const result = await readDocumentTool.handler({ path: "sample.xlsx" }, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Scores");
      expect(result.content).toContain("Name\tScore");
      expect(result.content).toContain("Alice\t90");
    });

    it("doesn't garble non-primitive cell values (e.g. a Date) into '[object Object]'", async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Dates");
      sheet.addRow([new Date("2024-01-15T00:00:00.000Z")]);
      await writeFile(path.join(dir, "dates.xlsx"), (await workbook.xlsx.writeBuffer()) as unknown as Buffer);

      const result = await readDocumentTool.handler({ path: "dates.xlsx" }, ctx());
      expect(result.content).not.toContain("[object Object]");
      expect(result.content).toContain("2024-01-15");
    });

    it("extracts text from a real .csv file, handling quoted commas correctly", async () => {
      await writeFile(path.join(dir, "sample.csv"), 'Name,Score,Note\nAlice,90,"Contains, a comma"\n');
      const result = await readDocumentTool.handler({ path: "sample.csv" }, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Name\tScore\tNote");
      expect(result.content).toContain("Alice\t90\tContains, a comma");
    });

    it("extracts text from a real legacy .doc file (from word-extractor's own test suite)", async () => {
      await copyFile(sampleDocFixture, path.join(dir, "sample.doc"));
      const result = await readDocumentTool.handler({ path: "sample.doc" }, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("This is a test of reviewing");
    });

    it("rejects an unsupported extension without touching disk further", async () => {
      await writeFile(path.join(dir, "notes.txt"), "plain text");
      const result = await readDocumentTool.handler({ path: "notes.txt" }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain(".pdf, .doc, .docx, .xlsx, .csv");
    });

    it("rejects a path escaping the project root", async () => {
      await expect(readDocumentTool.handler({ path: "../outside.pdf" }, ctx())).rejects.toThrow(
        /outside the project root/,
      );
    });
  });

  describe("write_spreadsheet", () => {
    it("writes a real .xlsx file, readable back by exceljs directly", async () => {
      const result = await writeSpreadsheetTool.handler(
        { path: "out.xlsx", rows: [["Name", "Score"], ["Bob", 85]] },
        ctx(),
      );
      expect(result.isError).toBe(false);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load((await readFile(path.join(dir, "out.xlsx"))) as any);
      const sheet = workbook.worksheets[0];
      expect(sheet.name).toBe("Sheet1");
      expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(["Name", "Score"]);
      expect((sheet.getRow(2).values as unknown[]).slice(1)).toEqual(["Bob", 85]);
    });

    it("uses a custom sheet name when given", async () => {
      await writeSpreadsheetTool.handler({ path: "out.xlsx", sheetName: "Custom", rows: [["a"]] }, ctx());

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load((await readFile(path.join(dir, "out.xlsx"))) as any);
      expect(workbook.worksheets[0].name).toBe("Custom");
    });

    it("round-trips through read_document", async () => {
      await writeSpreadsheetTool.handler({ path: "roundtrip.xlsx", rows: [["x", "y"], [1, 2]] }, ctx());
      const result = await readDocumentTool.handler({ path: "roundtrip.xlsx" }, ctx());
      expect(result.content).toContain("x\ty");
      expect(result.content).toContain("1\t2");
    });

    it("creates missing parent directories, like write_file", async () => {
      const result = await writeSpreadsheetTool.handler({ path: "nested/dir/out.xlsx", rows: [["a"]] }, ctx());
      expect(result.isError).toBe(false);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load((await readFile(path.join(dir, "nested/dir/out.xlsx"))) as any);
      expect(workbook.worksheets[0].name).toBe("Sheet1");
    });
  });

  describe("edit_spreadsheet", () => {
    it("updates specific cells, leaving the rest untouched", async () => {
      await writeSpreadsheetTool.handler({ path: "sheet.xlsx", rows: [["a", "b"], ["c", "d"]] }, ctx());

      const result = await editSpreadsheetTool.handler(
        { path: "sheet.xlsx", edits: [{ row: 2, col: 2, value: "changed" }] },
        ctx(),
      );
      expect(result.isError).toBe(false);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load((await readFile(path.join(dir, "sheet.xlsx"))) as any);
      const sheet = workbook.worksheets[0];
      expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(["a", "b"]);
      expect((sheet.getRow(2).values as unknown[]).slice(1)).toEqual(["c", "changed"]);
    });

    it("targets a named sheet when given", async () => {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet("First").addRow(["x"]);
      workbook.addWorksheet("Second").addRow(["y"]);
      await writeFile(path.join(dir, "multi.xlsx"), (await workbook.xlsx.writeBuffer()) as unknown as Buffer);

      await editSpreadsheetTool.handler(
        { path: "multi.xlsx", sheetName: "Second", edits: [{ row: 1, col: 1, value: "changed" }] },
        ctx(),
      );

      const reloaded = new ExcelJS.Workbook();
      await reloaded.xlsx.load((await readFile(path.join(dir, "multi.xlsx"))) as any);
      expect((reloaded.getWorksheet("First")!.getRow(1).values as unknown[]).slice(1)).toEqual(["x"]);
      expect((reloaded.getWorksheet("Second")!.getRow(1).values as unknown[]).slice(1)).toEqual(["changed"]);
    });

    it("reports an error for a sheet name that doesn't exist", async () => {
      await writeSpreadsheetTool.handler({ path: "sheet.xlsx", rows: [["a"]] }, ctx());
      const result = await editSpreadsheetTool.handler(
        { path: "sheet.xlsx", sheetName: "NoSuchSheet", edits: [{ row: 1, col: 1, value: "x" }] },
        ctx(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("NoSuchSheet");
    });
  });

  describe("merge_spreadsheets", () => {
    it("combines worksheets from multiple files into one output workbook", async () => {
      await writeSpreadsheetTool.handler({ path: "a.xlsx", sheetName: "Data", rows: [["from a"]] }, ctx());
      await writeSpreadsheetTool.handler({ path: "b.xlsx", sheetName: "Data", rows: [["from b"]] }, ctx());

      const result = await mergeSpreadsheetsTool.handler(
        { paths: ["a.xlsx", "b.xlsx"], outputPath: "merged.xlsx" },
        ctx(),
      );
      expect(result.isError).toBe(false);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load((await readFile(path.join(dir, "merged.xlsx"))) as any);
      expect(workbook.worksheets).toHaveLength(2);
      const names = workbook.worksheets.map((s) => s.name);
      expect(names).toContain("Data");
      expect(names).toContain("Data (2)");
    });

    it("requires at least 2 files", async () => {
      await writeSpreadsheetTool.handler({ path: "a.xlsx", rows: [["a"]] }, ctx());
      const result = await mergeSpreadsheetsTool.handler({ paths: ["a.xlsx"], outputPath: "out.xlsx" }, ctx());
      expect(result.isError).toBe(true);
    });
  });

  describe("merge_pdf", () => {
    it("combines pages from multiple real PDFs, in order", async () => {
      await writeFile(path.join(dir, "a.pdf"), await buildRealPdf("Document A page"));
      await writeFile(path.join(dir, "b.pdf"), await buildRealPdf("Document B page"));

      const result = await mergePdfTool.handler({ paths: ["a.pdf", "b.pdf"], outputPath: "merged.pdf" }, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("2 pages");

      const readBack = await readDocumentTool.handler({ path: "merged.pdf" }, ctx());
      expect(readBack.content).toContain("Document A page");
      expect(readBack.content).toContain("Document B page");
      expect(readBack.content.indexOf("Document A page")).toBeLessThan(readBack.content.indexOf("Document B page"));
    });

    it("requires at least 2 files", async () => {
      await writeFile(path.join(dir, "a.pdf"), await buildRealPdf("solo"));
      const result = await mergePdfTool.handler({ paths: ["a.pdf"], outputPath: "out.pdf" }, ctx());
      expect(result.isError).toBe(true);
    });
  });

  describe("write_document", () => {
    it("creates a real .docx readable back through read_document", async () => {
      const result = await writeDocumentTool.handler(
        { path: "out.docx", paragraphs: ["First paragraph.", "Second paragraph."] },
        ctx(),
      );
      expect(result.isError).toBe(false);

      const readBack = await readDocumentTool.handler({ path: "out.docx" }, ctx());
      expect(readBack.content).toContain("First paragraph.");
      expect(readBack.content).toContain("Second paragraph.");
    });
  });

  describe("edit_document", () => {
    it("replaces text that falls within a single XML run", async () => {
      await writeFile(path.join(dir, "doc.docx"), await buildDocxWithParagraphs([["Hello world, this is a test."]]));

      const result = await editDocumentTool.handler(
        { path: "doc.docx", old_string: "world", new_string: "there" },
        ctx(),
      );
      expect(result.isError).toBe(false);

      const readBack = await readDocumentTool.handler({ path: "doc.docx" }, ctx());
      expect(readBack.content).toContain("Hello there, this is a test.");
    });

    it("fails with a clear explanation when the text is split across multiple runs", async () => {
      await writeFile(
        path.join(dir, "split.docx"),
        await buildDocxWithParagraphs([["Hello ", "world, this is split."]]),
      );

      await expect(
        editDocumentTool.handler({ path: "split.docx", old_string: "Hello world", new_string: "Hi there" }, ctx()),
      ).rejects.toThrow(/across multiple runs/);
    });

    it("fails when old_string isn't found at all", async () => {
      await writeFile(path.join(dir, "doc.docx"), await buildDocxWithParagraphs([["Hello world."]]));
      await expect(
        editDocumentTool.handler({ path: "doc.docx", old_string: "nonexistent", new_string: "x" }, ctx()),
      ).rejects.toThrow(/not found/);
    });

    it("requires replace_all when old_string occurs more than once", async () => {
      await writeFile(path.join(dir, "doc.docx"), await buildDocxWithParagraphs([["cat cat cat"]]));
      await expect(
        editDocumentTool.handler({ path: "doc.docx", old_string: "cat", new_string: "dog" }, ctx()),
      ).rejects.toThrow(/occurs 3 times/);
    });

    it("replace_all replaces every occurrence, including across separate runs", async () => {
      await writeFile(
        path.join(dir, "doc.docx"),
        await buildDocxWithParagraphs([["cat"], ["cat"], ["cat"]]),
      );

      const result = await editDocumentTool.handler(
        { path: "doc.docx", old_string: "cat", new_string: "dog", replace_all: true },
        ctx(),
      );
      expect(result.isError).toBe(false);

      const readBack = await readDocumentTool.handler({ path: "doc.docx" }, ctx());
      expect(readBack.content).not.toContain("cat");
      expect(readBack.content.match(/dog/g) ?? []).toHaveLength(3);
    });
  });
});
