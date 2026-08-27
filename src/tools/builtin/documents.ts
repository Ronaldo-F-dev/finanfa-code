import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

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
  const workbook = new ExcelJS.Workbook();
  // exceljs's own .d.ts shadows the global `Buffer` with a local
  // `interface Buffer extends ArrayBuffer {}`, unrelated to Node's real
  // Buffer — a real Node Buffer is never structurally assignable to it, so
  // this boundary needs `any` rather than a Buffer-generic reshape.
  await workbook.xlsx.load(buffer as any);
  const sections: string[] = [];
  for (const sheet of workbook.worksheets) {
    const lines: string[] = [`# ${sheet.name}`];
    sheet.eachRow((row) => {
      const cells = (row.values as unknown[]).slice(1);
      lines.push(cells.map((c) => (c === null || c === undefined ? "" : String(c))).join("\t"));
    });
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n").trim();
}

interface ReadDocumentInput {
  path: string;
}

export const readDocumentTool: ToolDefinition<ReadDocumentInput> = {
  name: "read_document",
  description: "Extract text from a PDF, Word (.docx), or Excel (.xlsx) file. Not for legacy .doc/.xls formats.",
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
    const buffer = await readFile(filePath);

    let text: string;
    switch (ext) {
      case ".pdf":
        text = await extractPdf(buffer);
        if (!text) {
          return { content: "This PDF has no extractable text layer (likely a scanned image).", isError: false };
        }
        break;
      case ".docx":
        text = await extractDocx(buffer);
        break;
      case ".xlsx":
        text = await extractXlsx(buffer);
        break;
      default:
        return {
          content: `Unsupported document type "${ext || "(no extension)"}". Supported: .pdf, .docx, .xlsx (not legacy .doc/.xls).`,
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
    // writeBuffer()'s declared return type is exceljs's phantom "Buffer" (see
    // note in extractXlsx above) but returns a real Node Buffer at runtime.
    await writeFile(filePath, (await workbook.xlsx.writeBuffer()) as unknown as Buffer);

    return { content: `Wrote ${input.rows.length} rows to ${input.path}`, isError: false };
  },
};
