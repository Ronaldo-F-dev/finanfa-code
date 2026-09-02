import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { createConvertToPdfTool } from "../../src/tools/builtin/convert-to-pdf.js";
import { BrowserManager } from "../../src/browser/manager.js";

const PDF_MAGIC = Buffer.from("%PDF-");

async function extractPdfText(pdfPath: string): Promise<string> {
  const parser = new PDFParse({ data: await readFile(pdfPath) });
  try {
    const result = await parser.getText();
    return result.pages.map((p) => p.text).join("\n");
  } finally {
    await parser.destroy();
  }
}

describe("convert_to_pdf tool (real headless Chromium rendering)", () => {
  let dir: string;
  let browser: BrowserManager;

  beforeAll(() => {
    browser = new BrowserManager();
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-convert-pdf-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("converts real Markdown (heading, list, code block) to a real PDF with the text preserved", async () => {
    await writeFile(
      path.join(dir, "notes.md"),
      "# Hello World\n\nA list:\n\n- one\n- two\n\n```js\nconsole.log('hi');\n```\n",
    );
    const tool = createConvertToPdfTool(browser);

    const result = await tool.handler({ path: "notes.md" }, ctx());

    expect(result.isError).toBe(false);
    const bytes = await readFile(path.join(dir, "notes.pdf"));
    expect(bytes.subarray(0, 5)).toEqual(PDF_MAGIC);

    const text = await extractPdfText(path.join(dir, "notes.pdf"));
    expect(text).toContain("Hello World");
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("console.log");
  });

  it("converts a real .html file to PDF as-is, without double-wrapping it", async () => {
    await writeFile(
      path.join(dir, "page.html"),
      "<!doctype html><html><body><h1>Real HTML Page</h1><p>Body text.</p></body></html>",
    );
    const tool = createConvertToPdfTool(browser);

    const result = await tool.handler({ path: "page.html" }, ctx());

    expect(result.isError).toBe(false);
    const text = await extractPdfText(path.join(dir, "page.html").replace(/\.html$/, ".pdf"));
    expect(text).toContain("Real HTML Page");
    expect(text).toContain("Body text.");
  });

  it("converts a real .docx file to PDF, preserving its paragraph text", async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ children: [new TextRun("Docx Title Line")] }),
            new Paragraph({ children: [new TextRun("A second paragraph of real text.")] }),
          ],
        },
      ],
    });
    await writeFile(path.join(dir, "report.docx"), await Packer.toBuffer(doc));
    const tool = createConvertToPdfTool(browser);

    const result = await tool.handler({ path: "report.docx" }, ctx());

    expect(result.isError).toBe(false);
    const text = await extractPdfText(path.join(dir, "report.pdf"));
    expect(text).toContain("Docx Title Line");
    expect(text).toContain("A second paragraph of real text.");
  });

  it("respects a custom outputPath instead of the default same-name .pdf", async () => {
    await writeFile(path.join(dir, "src.md"), "# Custom output");
    const tool = createConvertToPdfTool(browser);

    const result = await tool.handler({ path: "src.md", outputPath: "out/final.pdf" }, ctx());

    expect(result.isError).toBe(false);
    const bytes = await readFile(path.join(dir, "out", "final.pdf"));
    expect(bytes.subarray(0, 5)).toEqual(PDF_MAGIC);
  });

  it("rejects an unsupported source format without touching the filesystem", async () => {
    await writeFile(path.join(dir, "data.json"), "{}");
    const tool = createConvertToPdfTool(browser);

    const result = await tool.handler({ path: "data.json" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported source format");
  });
});
