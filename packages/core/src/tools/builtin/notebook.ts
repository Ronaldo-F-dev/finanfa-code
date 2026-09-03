import { readFile, writeFile } from "node:fs/promises";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  outputs?: NotebookOutput[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
}

interface NotebookOutput {
  output_type: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
}

interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

function joinSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source;
}

// nbformat stores source as an array of lines, each ending in "\n" except
// the last — this keeps line-level diffs clean in a notebook's own JSON.
function toNbSource(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
}

function summarizeOutput(output: NotebookOutput): string {
  if (output.output_type === "stream") {
    return joinSource(output.text ?? "").trimEnd();
  }
  if (output.output_type === "error") {
    return `Error: ${output.ename}: ${output.evalue}`;
  }
  if (output.output_type === "execute_result" || output.output_type === "display_data") {
    const data = output.data ?? {};
    if (typeof data["text/plain"] === "string" || Array.isArray(data["text/plain"])) {
      return joinSource(data["text/plain"] as string | string[]).trimEnd();
    }
    const mimeTypes = Object.keys(data);
    return mimeTypes.length > 0 ? `[${mimeTypes.join(", ")} output, not shown]` : "[output]";
  }
  return `[${output.output_type} output]`;
}

async function loadNotebook(filePath: string): Promise<Notebook> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as Notebook;
}

async function saveNotebook(filePath: string, notebook: Notebook): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(notebook, null, 1)}\n`, "utf-8");
}

interface ReadNotebookInput {
  path: string;
}

export const readNotebookTool: ToolDefinition<ReadNotebookInput> = {
  name: "read_notebook",
  description:
    "Show a Jupyter notebook (.ipynb) cell by cell — source and a summary of each cell's outputs — instead of its raw, very verbose JSON.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to a .ipynb file, relative to the project root or absolute" },
    },
    required: ["path"],
  },
  describeCall: (input) => `read notebook ${input.path}`,
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const notebook = await loadNotebook(filePath);

    const sections = notebook.cells.map((cell, i) => {
      const lines = [`[${i}] ${cell.cell_type}:`, joinSource(cell.source)];
      for (const output of cell.outputs ?? []) lines.push(`  output: ${summarizeOutput(output)}`);
      return lines.join("\n");
    });

    return { content: sections.join("\n\n") || "(empty notebook)", isError: false };
  },
};

interface EditNotebookInput {
  path: string;
  action: "update" | "insert" | "delete";
  index: number;
  cellType?: "code" | "markdown" | "raw";
  source?: string;
}

export const editNotebookTool: ToolDefinition<EditNotebookInput> = {
  name: "edit_notebook",
  description:
    "Update, insert, or delete a cell in a Jupyter notebook (.ipynb) by 0-based index. update replaces a cell's " +
    "source (leaving its old outputs in place, now stale until re-run — same as editing a cell in Jupyter itself " +
    "without re-executing it). insert adds a new cell at index (cellType and source required). delete removes " +
    "the cell at index. Use read_notebook first to see current cell indices.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to a .ipynb file, relative to the project root or absolute" },
      action: { type: "string", enum: ["update", "insert", "delete"] },
      index: { type: "number", description: "0-based cell index" },
      cellType: { type: "string", enum: ["code", "markdown", "raw"], description: "Required for insert" },
      source: { type: "string", description: "New cell source text — required for update/insert" },
    },
    required: ["path", "action", "index"],
  },
  riskKey: (input) => input.path,
  describeCall: (input) => `${input.action} cell ${input.index} in ${input.path}`,
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const notebook = await loadNotebook(filePath);

    if (input.action === "delete") {
      if (input.index < 0 || input.index >= notebook.cells.length) {
        return { content: `Cell index ${input.index} out of range (notebook has ${notebook.cells.length} cells).`, isError: true };
      }
      notebook.cells.splice(input.index, 1);
    } else if (input.action === "insert") {
      if (!input.cellType || input.source === undefined) {
        return { content: "insert requires both cellType and source.", isError: true };
      }
      if (input.index < 0 || input.index > notebook.cells.length) {
        return { content: `Cell index ${input.index} out of range (notebook has ${notebook.cells.length} cells).`, isError: true };
      }
      const newCell: NotebookCell = { cell_type: input.cellType, source: toNbSource(input.source), metadata: {} };
      if (input.cellType === "code") {
        newCell.outputs = [];
        newCell.execution_count = null;
      }
      notebook.cells.splice(input.index, 0, newCell);
    } else {
      if (input.source === undefined) return { content: "update requires source.", isError: true };
      if (input.index < 0 || input.index >= notebook.cells.length) {
        return { content: `Cell index ${input.index} out of range (notebook has ${notebook.cells.length} cells).`, isError: true };
      }
      notebook.cells[input.index].source = toNbSource(input.source);
    }

    await saveNotebook(filePath, notebook);
    const pastTense = { update: "Updated", insert: "Inserted", delete: "Deleted" }[input.action];
    return { content: `${pastTense} cell ${input.index} in ${input.path}`, isError: false };
  },
};
