import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { readDocumentTool, writeSpreadsheetTool } from "../../src/tools/builtin/documents.js";

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

    it("rejects an unsupported extension without touching disk further", async () => {
      await writeFile(path.join(dir, "notes.txt"), "plain text");
      const result = await readDocumentTool.handler({ path: "notes.txt" }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain(".pdf, .docx, .xlsx");
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
});
