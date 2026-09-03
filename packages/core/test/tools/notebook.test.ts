import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readNotebookTool, editNotebookTool } from "../../src/tools/builtin/notebook.js";

function sampleNotebook() {
  return {
    cells: [
      { cell_type: "markdown", source: ["# Title\n", "\n", "Some intro text."], metadata: {} },
      {
        cell_type: "code",
        source: ["print('hello')\n", "print('world')"],
        metadata: {},
        execution_count: 1,
        outputs: [{ output_type: "stream", name: "stdout", text: ["hello\n", "world\n"] }],
      },
      {
        cell_type: "code",
        source: ["1 / 0"],
        metadata: {},
        execution_count: 2,
        outputs: [{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: [] }],
      },
    ],
    metadata: { kernelspec: { name: "python3" } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

describe("notebook tools (real .ipynb JSON)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-notebook-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  describe("read_notebook", () => {
    it("shows each cell's source and a summary of its outputs", async () => {
      await writeFile(path.join(dir, "nb.ipynb"), JSON.stringify(sampleNotebook()));

      const result = await readNotebookTool.handler({ path: "nb.ipynb" }, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("[0] markdown:");
      expect(result.content).toContain("# Title");
      expect(result.content).toContain("[1] code:");
      expect(result.content).toContain("print('hello')");
      expect(result.content).toContain("output: hello\nworld");
      expect(result.content).toContain("[2] code:");
      expect(result.content).toContain("output: Error: ZeroDivisionError: division by zero");
    });

    it("reports an empty notebook cleanly", async () => {
      await writeFile(
        path.join(dir, "empty.ipynb"),
        JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
      );
      const result = await readNotebookTool.handler({ path: "empty.ipynb" }, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toBe("(empty notebook)");
    });

    it("summarizes a non-text output (e.g. an image) without dumping raw data", async () => {
      const nb = sampleNotebook();
      nb.cells.push({
        cell_type: "code",
        source: ["plot()"],
        metadata: {},
        execution_count: 3,
        outputs: [{ output_type: "display_data", data: { "image/png": "aGVsbG8=" } }],
      } as any);
      await writeFile(path.join(dir, "nb.ipynb"), JSON.stringify(nb));

      const result = await readNotebookTool.handler({ path: "nb.ipynb" }, ctx());
      expect(result.content).toContain("[image/png output, not shown]");
      expect(result.content).not.toContain("aGVsbG8=");
    });
  });

  describe("edit_notebook", () => {
    it("update replaces a cell's source, in valid nbformat line-array form", async () => {
      await writeFile(path.join(dir, "nb.ipynb"), JSON.stringify(sampleNotebook()));

      const result = await editNotebookTool.handler(
        { path: "nb.ipynb", action: "update", index: 1, source: "print('changed')" },
        ctx(),
      );
      expect(result.isError).toBe(false);

      const saved = JSON.parse(await readFile(path.join(dir, "nb.ipynb"), "utf-8"));
      expect(saved.cells[1].source).toEqual(["print('changed')"]);
      // outputs deliberately left stale, same as editing a cell in Jupyter without re-running
      expect(saved.cells[1].outputs).toHaveLength(1);
    });

    it("update rejects an out-of-range index", async () => {
      await writeFile(path.join(dir, "nb.ipynb"), JSON.stringify(sampleNotebook()));
      const result = await editNotebookTool.handler({ path: "nb.ipynb", action: "update", index: 99, source: "x" }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("out of range");
    });

    it("insert adds a new cell at the given index, shifting later cells down", async () => {
      await writeFile(path.join(dir, "nb.ipynb"), JSON.stringify(sampleNotebook()));

      const result = await editNotebookTool.handler(
        { path: "nb.ipynb", action: "insert", index: 1, cellType: "code", source: "x = 1" },
        ctx(),
      );
      expect(result.isError).toBe(false);

      const saved = JSON.parse(await readFile(path.join(dir, "nb.ipynb"), "utf-8"));
      expect(saved.cells).toHaveLength(4);
      expect(saved.cells[1].cell_type).toBe("code");
      expect(saved.cells[1].source).toEqual(["x = 1"]);
      expect(saved.cells[1].outputs).toEqual([]);
      // the original cell 1 (print hello/world) is now at index 2
      expect(saved.cells[2].source.join("")).toContain("print('hello')");
    });

    it("insert requires cellType and source", async () => {
      await writeFile(path.join(dir, "nb.ipynb"), JSON.stringify(sampleNotebook()));
      const result = await editNotebookTool.handler({ path: "nb.ipynb", action: "insert", index: 0 }, ctx());
      expect(result.isError).toBe(true);
    });

    it("delete removes the cell at the given index", async () => {
      await writeFile(path.join(dir, "nb.ipynb"), JSON.stringify(sampleNotebook()));

      const result = await editNotebookTool.handler({ path: "nb.ipynb", action: "delete", index: 2 }, ctx());
      expect(result.isError).toBe(false);

      const saved = JSON.parse(await readFile(path.join(dir, "nb.ipynb"), "utf-8"));
      expect(saved.cells).toHaveLength(2);
      expect(saved.cells.some((c: any) => c.source.join("").includes("ZeroDivisionError"))).toBe(false);
    });

    it("round-trips through read_notebook after an edit", async () => {
      await writeFile(path.join(dir, "nb.ipynb"), JSON.stringify(sampleNotebook()));
      await editNotebookTool.handler({ path: "nb.ipynb", action: "update", index: 0, source: "# New title" }, ctx());

      const result = await readNotebookTool.handler({ path: "nb.ipynb" }, ctx());
      expect(result.content).toContain("# New title");
      expect(result.content).not.toContain("Some intro text");
    });
  });
});
