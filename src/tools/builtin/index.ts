import type { ToolRegistry } from "../registry.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { bashTool } from "./bash.js";
import { webSearchTool } from "./web-search.js";
import { webFetchTool } from "./web-fetch.js";
import { previewHtmlTool } from "./preview-html.js";
import { todoWriteTool } from "./todo-write.js";
import { viewImageTool } from "./view-image.js";
import { gitTools } from "./git.js";
import { runTestsTool } from "./run-tests.js";
import { readDocumentTool, writeSpreadsheetTool } from "./documents.js";

export function registerBuiltins(registry: ToolRegistry): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(bashTool);
  registry.register(webSearchTool);
  registry.register(webFetchTool);
  registry.register(previewHtmlTool);
  registry.register(todoWriteTool);
  registry.register(viewImageTool);
  registry.register(runTestsTool);
  registry.register(readDocumentTool);
  registry.register(writeSpreadsheetTool);
  for (const tool of gitTools) registry.register(tool);
}
