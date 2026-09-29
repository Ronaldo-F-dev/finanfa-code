import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { loadDocument, loadDirectory } from "../../../src/core/rag/document-loader.js";

const sampleDocFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/sample.doc");

async function buildRealPdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 20, y: 150, size: 14, font });
  return Buffer.from(await doc.save());
}

describe("document-loader (real files, real libraries)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-document-loader-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("loadDocument", () => {
    it("extracts text from a real PDF and reports type + hash + mtime", async () => {
      const filePath = path.join(dir, "sample.pdf");
      await writeFile(filePath, await buildRealPdf("Hello real PDF fixture"));

      const doc = await loadDocument(filePath);
      expect(doc.type).toBe("pdf");
      expect(doc.text).toContain("Hello real PDF fixture");
      expect(doc.sourcePath).toBe(path.resolve(filePath));
      expect(doc.contentHash).toBe(createHash("sha256").update(doc.text).digest("hex"));
      expect(doc.mtimeMs).toBeGreaterThan(0);
      expect(doc.frontmatter).toBeUndefined();
    });

    it("extracts text from a real .docx file", async () => {
      const wordDoc = new Document({
        sections: [{ children: [new Paragraph({ children: [new TextRun("First paragraph.")] })] }],
      });
      const filePath = path.join(dir, "sample.docx");
      await writeFile(filePath, await Packer.toBuffer(wordDoc));

      const doc = await loadDocument(filePath);
      expect(doc.type).toBe("docx");
      expect(doc.text).toContain("First paragraph.");
    });

    it("extracts text from a real legacy .doc file", async () => {
      const filePath = path.join(dir, "sample.doc");
      await copyFile(sampleDocFixture, filePath);

      const doc = await loadDocument(filePath);
      expect(doc.type).toBe("doc");
      expect(doc.text).toContain("This is a test of reviewing");
    });

    it("extracts text from a real .xlsx file", async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Scores");
      sheet.addRow(["Name", "Score"]);
      sheet.addRow(["Alice", 90]);
      const filePath = path.join(dir, "sample.xlsx");
      await writeFile(filePath, (await workbook.xlsx.writeBuffer()) as unknown as Buffer);

      const doc = await loadDocument(filePath);
      expect(doc.type).toBe("xlsx");
      expect(doc.text).toContain("Alice\t90");
    });

    it("extracts text from a real .csv file", async () => {
      const filePath = path.join(dir, "sample.csv");
      await writeFile(filePath, "Name,Score\nAlice,90\n");

      const doc = await loadDocument(filePath);
      expect(doc.type).toBe("csv");
      expect(doc.text).toContain("Alice\t90");
    });

    it("loads plain text files verbatim", async () => {
      const filePath = path.join(dir, "notes.txt");
      await writeFile(filePath, "  plain text notes  \n");

      const doc = await loadDocument(filePath);
      expect(doc.type).toBe("text");
      expect(doc.text).toBe("plain text notes");
    });

    it("separates Markdown frontmatter from body content", async () => {
      const filePath = path.join(dir, "spec.md");
      await writeFile(
        filePath,
        `---\ntitle: My Spec\ntags:\n  - internal\n  - draft\n---\n\n# Heading\n\nBody content here.\n`,
      );

      const doc = await loadDocument(filePath);
      expect(doc.type).toBe("markdown");
      expect(doc.frontmatter).toEqual({ title: "My Spec", tags: ["internal", "draft"] });
      expect(doc.text).not.toContain("title: My Spec");
      expect(doc.text).toContain("# Heading");
      expect(doc.text).toContain("Body content here.");
    });

    it("has no frontmatter for a Markdown file without a frontmatter block", async () => {
      const filePath = path.join(dir, "plain.md");
      await writeFile(filePath, "# Just a heading\n\nNo frontmatter here.\n");

      const doc = await loadDocument(filePath);
      expect(doc.frontmatter).toBeUndefined();
      expect(doc.text).toContain("Just a heading");
    });

    it("throws a clear error for an unsupported file type", async () => {
      const filePath = path.join(dir, "image.png");
      await writeFile(filePath, Buffer.from([0]));
      await expect(loadDocument(filePath)).rejects.toThrow(/Unsupported document type/);
    });

    it("throws a clear error for a missing file", async () => {
      await expect(loadDocument(path.join(dir, "does-not-exist.pdf"))).rejects.toThrow(/File not found/);
    });
  });

  describe("loadDirectory", () => {
    it("walks a directory, loading every supported file and skipping the rest", async () => {
      await writeFile(path.join(dir, "notes.md"), "# Notes\n\nSome notes.\n");
      await writeFile(path.join(dir, "data.csv"), "a,b\n1,2\n");
      await writeFile(path.join(dir, "image.png"), Buffer.from([0]));

      await mkdir(path.join(dir, "sub"), { recursive: true });
      await writeFile(path.join(dir, "sub", "more.txt"), "nested text file");

      await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
      await writeFile(path.join(dir, "node_modules", "pkg", "readme.md"), "# should be skipped\n");

      await mkdir(path.join(dir, ".git"), { recursive: true });
      await writeFile(path.join(dir, ".git", "config.txt"), "should be skipped");

      await mkdir(path.join(dir, ".hidden"), { recursive: true });
      await writeFile(path.join(dir, ".hidden", "secret.md"), "# hidden, should be skipped\n");

      const result = await loadDirectory(dir);
      const paths = result.documents.map((d) => path.relative(dir, d.sourcePath)).sort();

      expect(paths).toEqual([path.join("sub", "more.txt"), "data.csv", "notes.md"].sort());
      expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
      expect(paths.some((p) => p.includes(".git"))).toBe(false);
      expect(paths.some((p) => p.includes(".hidden"))).toBe(false);
    });

    it("returns an empty result for a directory with no supported files", async () => {
      await writeFile(path.join(dir, "image.png"), Buffer.from([0]));
      const result = await loadDirectory(dir);
      expect(result.documents).toEqual([]);
      expect(result.skipped).toEqual([]);
    });
  });
});
