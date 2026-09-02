import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

interface ConvertSpreadsheetInput {
  path: string;
  outputPath?: string;
  sheetName?: string;
}

function defaultOutputPath(sourcePath: string, targetExt: string): string {
  return sourcePath.replace(/\.[^./\\]+$/, "") + targetExt;
}

export const convertSpreadsheetTool: ToolDefinition<ConvertSpreadsheetInput> = {
  name: "convert_spreadsheet",
  description:
    "Convert between .xlsx and .csv — direction is automatic from the source file's extension (.xlsx in " +
    "produces .csv out, and vice versa). Converting from .xlsx exports one sheet (sheetName, default: the " +
    "first) since CSV has no concept of multiple sheets. Without outputPath, writes next to the source with " +
    "the same name and the other extension.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source file, .xlsx or .csv" },
      outputPath: { type: "string", description: "Where to write the result (default: source path with the other extension)" },
      sheetName: { type: "string", description: "Which sheet to export when converting from .xlsx (default: the first sheet)" },
    },
    required: ["path"],
  },
  riskKey: (input) => input.outputPath ?? input.path,
  describeCall: (input) => {
    const ext = path.extname(input.path).toLowerCase();
    const targetExt = ext === ".csv" ? ".xlsx" : ".csv";
    return `convert ${input.path} -> ${input.outputPath ?? defaultOutputPath(input.path, targetExt)}`;
  },
  async handler(input, ctx) {
    const sourcePath = resolveAllowedPath(ctx.cwd, input.path);
    const ext = path.extname(sourcePath).toLowerCase();

    if (ext !== ".xlsx" && ext !== ".csv") {
      return { content: `Unsupported source format "${ext}" — convert_spreadsheet handles .xlsx and .csv only.`, isError: true };
    }

    const targetExt = ext === ".csv" ? ".xlsx" : ".csv";
    const destPath = resolveAllowedPath(ctx.cwd, input.outputPath ?? defaultOutputPath(input.path, targetExt));
    await mkdir(path.dirname(destPath), { recursive: true });

    // exceljs's own .d.ts shadows the global `Buffer` name with a local
    // `interface Buffer extends ArrayBuffer {}` — real Node Buffers need an
    // `any`/`unknown` escape hatch at these boundaries, same as documents.ts.
    if (ext === ".xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load((await readFile(sourcePath)) as any);
      const sheetName = input.sheetName ?? workbook.worksheets[0]?.name;
      if (!sheetName) return { content: `${input.path} has no worksheets.`, isError: true };
      if (!workbook.getWorksheet(sheetName)) {
        return { content: `Sheet "${sheetName}" not found in ${input.path}.`, isError: true };
      }
      await workbook.csv.writeFile(destPath, { sheetName });
    } else {
      const workbook = new ExcelJS.Workbook();
      await workbook.csv.readFile(sourcePath);
      await writeFile(destPath, (await workbook.xlsx.writeBuffer()) as unknown as Buffer);
    }

    return { content: `Converted ${input.path} -> ${path.relative(ctx.cwd, destPath)}`, isError: false };
  },
};
