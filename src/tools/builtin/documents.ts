import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { PDFDocument } from "pdf-lib";
import mammoth from "mammoth";
import { Document, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import WordExtractor from "word-extractor";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

// exceljs's own .d.ts shadows the global `Buffer` name with a local
// `interface Buffer extends ArrayBuffer {}`, unrelated to Node's real
// Buffer — a real Node Buffer is never structurally assignable to it (in
// either direction), so every exceljs boundary needs an `any`/`unknown`
// escape hatch rather than a Buffer-generic reshape.
async function loadXlsxWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  return workbook;
}

async function xlsxWorkbookToBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}

const MAX_CHARS = 100_000;

function truncate(s: string): string {
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n... (truncated, ${s.length} characters total)` : s;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    // result.text concatenates pages with an injected "-- N of M --" marker
    // even when every page is blank, so it's never actually empty — use the
    // per-page text (unmarked) to detect a PDF with no extractable text.
    return result.pages.map((p) => p.text).join("\n\n").trim();
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value.trim();
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const obj = value as { text?: unknown; richText?: { text: string }[]; result?: unknown; error?: unknown };
    if (Array.isArray(obj.richText)) return obj.richText.map((r) => r.text).join("");
    if (obj.error !== undefined) return String(obj.error);
    if (obj.result !== undefined) return cellToString(obj.result);
    if (obj.text !== undefined) return cellToString(obj.text);
    return JSON.stringify(value);
  }
  return String(value);
}

async function extractXlsx(buffer: Buffer): Promise<string> {
  const workbook = await loadXlsxWorkbook(buffer);
  const sections: string[] = [];
  for (const sheet of workbook.worksheets) {
    const lines: string[] = [`# ${sheet.name}`];
    sheet.eachRow((row) => {
      const cells = (row.values as unknown[]).slice(1);
      lines.push(cells.map(cellToString).join("\t"));
    });
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n").trim();
}

async function extractCsv(filePath: string): Promise<string> {
  // exceljs's csv reader only takes a path, not a buffer, but it's the same
  // proper quote/escape-aware CSV parser used elsewhere in the project, so
  // it's worth the extra readFile-by-path rather than hand-rolling one.
  const workbook = new ExcelJS.Workbook();
  const sheet = await workbook.csv.readFile(filePath);
  const lines: string[] = [];
  sheet.eachRow((row) => {
    const cells = (row.values as unknown[]).slice(1);
    lines.push(cells.map(cellToString).join("\t"));
  });
  return lines.join("\n").trim();
}

async function extractDoc(buffer: Buffer): Promise<string> {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  return doc.getBody().trim();
}

interface ReadDocumentInput {
  path: string;
}

export const readDocumentTool: ToolDefinition<ReadDocumentInput> = {
  name: "read_document",
  description: "Extract text from a PDF, Word (.doc/.docx), Excel (.xlsx), or CSV file. Not for legacy .xls.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root, or an absolute path (e.g. under the user's home directory)" },
    },
    required: ["path"],
  },
  describeCall: (input) => `read document ${input.path}`,
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const ext = path.extname(filePath).toLowerCase();

    let text: string;
    switch (ext) {
      case ".pdf":
        text = await extractPdf(await readFile(filePath));
        if (!text) {
          return { content: "This PDF has no extractable text layer (likely a scanned image).", isError: false };
        }
        break;
      case ".docx":
        text = await extractDocx(await readFile(filePath));
        break;
      case ".doc":
        text = await extractDoc(await readFile(filePath));
        break;
      case ".xlsx":
        text = await extractXlsx(await readFile(filePath));
        break;
      case ".csv":
        text = await extractCsv(filePath);
        break;
      default:
        return {
          content: `Unsupported document type "${ext || "(no extension)"}". Supported: .pdf, .doc, .docx, .xlsx, .csv (not legacy .xls).`,
          isError: true,
        };
    }

    return { content: truncate(text), isError: false };
  },
};

type SpreadsheetCell = string | number | boolean | null;

interface WriteSpreadsheetInput {
  path: string;
  sheetName?: string;
  rows: SpreadsheetCell[][];
}

export const writeSpreadsheetTool: ToolDefinition<WriteSpreadsheetInput> = {
  name: "write_spreadsheet",
  description:
    "Create a simple .xlsx spreadsheet from rows of data (each row an array of cell values; include a header row yourself if you want one).",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root, or an absolute path (e.g. under the user's home directory), ending in .xlsx" },
      sheetName: { type: "string", description: 'Worksheet name (default: "Sheet1")' },
      rows: {
        type: "array",
        items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
        description: "Row data, top to bottom. Each inner array is one row's cell values, left to right.",
      },
    },
    required: ["path", "rows"],
  },
  riskKey: (input) => input.path,
  describeCall: (input) => `write spreadsheet ${input.path} (${input.rows.length} rows)`,
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(input.sheetName ?? "Sheet1");
    for (const row of input.rows) sheet.addRow(row);

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, await xlsxWorkbookToBuffer(workbook));

    return { content: `Wrote ${input.rows.length} rows to ${input.path}`, isError: false };
  },
};

interface SpreadsheetCellEdit {
  row: number;
  col: number;
  value: SpreadsheetCell;
}

interface EditSpreadsheetInput {
  path: string;
  sheetName?: string;
  edits: SpreadsheetCellEdit[];
}

export const editSpreadsheetTool: ToolDefinition<EditSpreadsheetInput> = {
  name: "edit_spreadsheet",
  description:
    "Update specific cells in an existing .xlsx file, by 1-based row/column number, leaving everything else untouched. Use read_document first to see current values and figure out row/column numbers.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to an existing .xlsx file, relative to the project root or absolute" },
      sheetName: { type: "string", description: "Worksheet to edit (default: the first sheet)" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            row: { type: "number", description: "1-based row number" },
            col: { type: "number", description: "1-based column number" },
            value: { type: ["string", "number", "boolean", "null"] },
          },
          required: ["row", "col", "value"],
        },
        description: "Cells to update",
      },
    },
    required: ["path", "edits"],
  },
  riskKey: (input) => input.path,
  describeCall: (input) => `edit ${input.edits.length} cells in ${input.path}`,
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const workbook = await loadXlsxWorkbook(await readFile(filePath));
    const sheet = input.sheetName ? workbook.getWorksheet(input.sheetName) : workbook.worksheets[0];
    if (!sheet) return { content: `Sheet "${input.sheetName}" not found in ${input.path}.`, isError: true };

    for (const edit of input.edits) sheet.getCell(edit.row, edit.col).value = edit.value;

    await writeFile(filePath, await xlsxWorkbookToBuffer(workbook));
    return { content: `Updated ${input.edits.length} cells in ${input.path}`, isError: false };
  },
};

interface MergeSpreadsheetsInput {
  paths: string[];
  outputPath: string;
}

export const mergeSpreadsheetsTool: ToolDefinition<MergeSpreadsheetsInput> = {
  name: "merge_spreadsheets",
  description:
    "Combine multiple .xlsx files into one output file — each source file's worksheets are copied in as separate sheets (renamed on name collision). Copies cell values only, not styling or formulas.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "Source .xlsx files, in order" },
      outputPath: { type: "string", description: "Path for the merged output .xlsx" },
    },
    required: ["paths", "outputPath"],
  },
  riskKey: (input) => input.outputPath,
  describeCall: (input) => `merge ${input.paths.length} spreadsheets into ${input.outputPath}`,
  async handler(input, ctx) {
    if (input.paths.length < 2) return { content: "Need at least 2 spreadsheet files to merge.", isError: true };
    const outputPath = resolveAllowedPath(ctx.cwd, input.outputPath);

    const merged = new ExcelJS.Workbook();
    const usedNames = new Set<string>();
    for (const p of input.paths) {
      const srcPath = resolveAllowedPath(ctx.cwd, p);
      const src = await loadXlsxWorkbook(await readFile(srcPath));
      for (const sheet of src.worksheets) {
        let name = sheet.name;
        for (let n = 2; usedNames.has(name); n++) name = `${sheet.name} (${n})`;
        usedNames.add(name);

        const newSheet = merged.addWorksheet(name);
        sheet.eachRow((row) => newSheet.addRow((row.values as unknown[]).slice(1)));
      }
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, await xlsxWorkbookToBuffer(merged));
    return {
      content: `Merged ${input.paths.length} spreadsheets (${merged.worksheets.length} sheets total) into ${input.outputPath}`,
      isError: false,
    };
  },
};

interface MergePdfInput {
  paths: string[];
  outputPath: string;
}

export const mergePdfTool: ToolDefinition<MergePdfInput> = {
  name: "merge_pdf",
  description: "Combine multiple PDF files into one, in the given order, all pages included.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "PDF files to merge, in order" },
      outputPath: { type: "string", description: "Path for the merged output PDF" },
    },
    required: ["paths", "outputPath"],
  },
  riskKey: (input) => input.outputPath,
  describeCall: (input) => `merge ${input.paths.length} PDFs into ${input.outputPath}`,
  async handler(input, ctx) {
    if (input.paths.length < 2) return { content: "Need at least 2 PDF files to merge.", isError: true };
    const outputPath = resolveAllowedPath(ctx.cwd, input.outputPath);

    const merged = await PDFDocument.create();
    for (const p of input.paths) {
      const srcPath = resolveAllowedPath(ctx.cwd, p);
      const src = await PDFDocument.load(await readFile(srcPath));
      const pages = await merged.copyPages(src, src.getPageIndices());
      for (const page of pages) merged.addPage(page);
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, await merged.save());
    return {
      content: `Merged ${input.paths.length} PDFs (${merged.getPageCount()} pages total) into ${input.outputPath}`,
      isError: false,
    };
  },
};

interface WriteDocumentInput {
  path: string;
  paragraphs: string[];
}

export const writeDocumentTool: ToolDefinition<WriteDocumentInput> = {
  name: "write_document",
  description:
    "Create a simple .docx file from plain-text paragraphs (each array entry becomes one paragraph). No rich formatting — bold, tables, and images aren't supported.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root, or an absolute path, ending in .docx" },
      paragraphs: { type: "array", items: { type: "string" }, description: "Paragraph text, in order" },
    },
    required: ["path", "paragraphs"],
  },
  riskKey: (input) => input.path,
  describeCall: (input) => `write document ${input.path} (${input.paragraphs.length} paragraphs)`,
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const doc = new Document({
      sections: [{ children: input.paragraphs.map((text) => new Paragraph({ children: [new TextRun(text)] })) }],
    });

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, await Packer.toBuffer(doc));

    return { content: `Wrote ${input.paragraphs.length} paragraphs to ${input.path}`, isError: false };
  },
};

function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function encodeXmlEntities(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const DOCX_RUN_RE = /<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g;

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

function applyDocxEdit(xml: string, oldString: string, newString: string, replaceAll: boolean): string {
  const runs = [...xml.matchAll(DOCX_RUN_RE)];
  const totalOccurrences = runs.reduce((sum, run) => sum + countOccurrences(decodeXmlEntities(run[2]), oldString), 0);

  if (totalOccurrences === 0) {
    const fullText = runs.map((r) => decodeXmlEntities(r[2])).join("");
    if (fullText.includes(oldString)) {
      throw new Error(
        "old_string not found within a single text run — Word often splits a sentence across multiple runs " +
          "(formatting boundaries, spell-check), which can't be safely edited this way. Try a shorter, more " +
          "specific fragment.",
      );
    }
    throw new Error("old_string not found in the document");
  }
  if (totalOccurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string occurs ${totalOccurrences} times in the document; pass replace_all:true or provide more context to make it unique`,
    );
  }

  return xml.replace(DOCX_RUN_RE, (full, attrs, content) => {
    const decoded = decodeXmlEntities(content);
    if (!decoded.includes(oldString)) return full;
    return `<w:t${attrs}>${encodeXmlEntities(decoded.split(oldString).join(newString))}</w:t>`;
  });
}

interface EditDocumentInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const editDocumentTool: ToolDefinition<EditDocumentInput> = {
  name: "edit_document",
  description:
    "Best-effort exact-text replacement in an existing .docx file. Only works when old_string falls entirely within one XML text run — Word often splits a sentence across several runs (formatting, spell-check), in which case this fails with an explanation rather than silently missing the edit. Use read_document first to see the current text, and prefer short, distinctive fragments.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to an existing .docx file, relative to the project root or absolute" },
      old_string: { type: "string", description: "Exact text to find" },
      new_string: { type: "string", description: "Text to replace it with" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness" },
    },
    required: ["path", "old_string", "new_string"],
  },
  riskKey: (input) => input.path,
  describeCall: (input) => `edit ${input.path}`,
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const zip = await JSZip.loadAsync(await readFile(filePath));
    const docXml = zip.file("word/document.xml");
    if (!docXml) return { content: `${input.path} doesn't look like a valid .docx file (missing word/document.xml).`, isError: true };

    const xml = await docXml.async("string");
    const newXml = applyDocxEdit(xml, input.old_string, input.new_string, input.replace_all ?? false);
    zip.file("word/document.xml", newXml);

    await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));
    return { content: `Edited ${input.path}`, isError: false };
  },
};
