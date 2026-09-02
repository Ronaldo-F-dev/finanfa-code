import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { convertSpreadsheetTool } from "../../src/tools/builtin/convert-spreadsheet.js";

describe("convert_spreadsheet tool (real exceljs xlsx<->csv round-trips)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-convert-sheet-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("converts a real .xlsx to .csv", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Data");
    sheet.addRow(["name", "age"]);
    sheet.addRow(["Alice", 30]);
    sheet.addRow(["Bob", 25]);
    await writeFile(path.join(dir, "people.xlsx"), (await workbook.xlsx.writeBuffer()) as unknown as Buffer);

    const result = await convertSpreadsheetTool.handler({ path: "people.xlsx" }, ctx());

    expect(result.isError).toBe(false);
    const csv = await readFile(path.join(dir, "people.csv"), "utf-8");
    expect(csv).toContain("name,age");
    expect(csv).toContain("Alice,30");
    expect(csv).toContain("Bob,25");
  });

  it("converts a real .csv to .xlsx, readable back with exceljs", async () => {
    await writeFile(path.join(dir, "rows.csv"), "name,age\nAlice,30\nBob,25\n");

    const result = await convertSpreadsheetTool.handler({ path: "rows.csv" }, ctx());

    expect(result.isError).toBe(false);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await readFile(path.join(dir, "rows.xlsx"))) as any);
    const sheet = workbook.worksheets[0];
    expect(sheet.getRow(1).getCell(1).value).toBe("name");
    expect(sheet.getRow(2).getCell(1).value).toBe("Alice");
    expect(sheet.getRow(2).getCell(2).value).toBe(30);
  });

  it("exports a specific named sheet, not just the first one", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("First").addRow(["a"]);
    workbook.addWorksheet("Second").addRow(["b"]);
    await writeFile(path.join(dir, "multi.xlsx"), (await workbook.xlsx.writeBuffer()) as unknown as Buffer);

    const result = await convertSpreadsheetTool.handler({ path: "multi.xlsx", sheetName: "Second" }, ctx());

    expect(result.isError).toBe(false);
    const csv = await readFile(path.join(dir, "multi.csv"), "utf-8");
    expect(csv).toContain("b");
    expect(csv).not.toContain("a");
  });

  it("respects a custom outputPath", async () => {
    await writeFile(path.join(dir, "in.csv"), "x\n1\n");
    const result = await convertSpreadsheetTool.handler({ path: "in.csv", outputPath: "out/result.xlsx" }, ctx());
    expect(result.isError).toBe(false);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await readFile(path.join(dir, "out", "result.xlsx"))) as any);
    expect(workbook.worksheets[0].getCell(1, 1).value).toBe("x");
  });

  it("rejects an unsupported source format", async () => {
    await writeFile(path.join(dir, "notes.txt"), "hi");
    const result = await convertSpreadsheetTool.handler({ path: "notes.txt" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported source format");
  });

  it("reports a clear error for a missing named sheet", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("OnlySheet").addRow(["a"]);
    await writeFile(path.join(dir, "one.xlsx"), (await workbook.xlsx.writeBuffer()) as unknown as Buffer);

    const result = await convertSpreadsheetTool.handler({ path: "one.xlsx", sheetName: "Nope" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Nope");
  });
});
