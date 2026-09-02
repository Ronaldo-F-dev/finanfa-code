import type { ToolRegistry } from "../registry.js";
import type { LlmProvider } from "../../core/types.js";
import type { PermissionManager } from "../../permissions/manager.js";
import type { UIAdapter } from "../../ui/adapter.js";
import type { BrowserManager } from "../../browser/manager.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { bashTool } from "./bash.js";
import { webSearchTool } from "./web-search.js";
import { webFetchTool } from "./web-fetch.js";
import { todoWriteTool } from "./todo-write.js";
import { viewImageTool } from "./view-image.js";
import { gitTools } from "./git.js";
import { runTestsTool } from "./run-tests.js";
import {
  readDocumentTool,
  writeSpreadsheetTool,
  editSpreadsheetTool,
  mergeSpreadsheetsTool,
  mergePdfTool,
  writeDocumentTool,
  editDocumentTool,
} from "./documents.js";
import { readNotebookTool, editNotebookTool } from "./notebook.js";
import { checkPythonTypesTool } from "./check-python-types.js";
import { checkTypescriptTypesTool } from "./check-typescript-types.js";
import { lintPythonTool } from "./lint-python.js";
import { resizeImageTool } from "./resize-image.js";
import { queryDatabaseTool } from "./query-database.js";
import { httpRequestTool } from "./http-request.js";
import { waitForPortTool } from "./wait-for-port.js";
import { lintJavascriptTool } from "./lint-javascript.js";
import { createTaskTool } from "./task.js";
import { createBrowserTools } from "./browser.js";
import { createBackgroundProcessTools } from "./background-process.js";
import { BackgroundProcessManager } from "../../core/background-process.js";
import { createPythonReplTool } from "./python-repl.js";
import { PythonReplManager } from "../../core/python-repl.js";
import { createPreviewHtmlTool } from "./preview-html.js";
import { createArtifactTool } from "./create-artifact.js";
import { PreviewServer } from "../../core/preview-server.js";
import { generate3dTool } from "./generate-3d.js";

/** Stateless builtins — no shared instance state, safe to register in any order. */
export function registerBuiltins(registry: ToolRegistry): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(bashTool);
  registry.register(webSearchTool);
  registry.register(webFetchTool);
  registry.register(todoWriteTool);
  registry.register(viewImageTool);
  registry.register(runTestsTool);
  registry.register(readDocumentTool);
  registry.register(writeSpreadsheetTool);
  registry.register(editSpreadsheetTool);
  registry.register(mergeSpreadsheetsTool);
  registry.register(mergePdfTool);
  registry.register(writeDocumentTool);
  registry.register(editDocumentTool);
  registry.register(readNotebookTool);
  registry.register(editNotebookTool);
  registry.register(checkPythonTypesTool);
  registry.register(checkTypescriptTypesTool);
  registry.register(lintPythonTool);
  registry.register(resizeImageTool);
  registry.register(queryDatabaseTool);
  registry.register(httpRequestTool);
  registry.register(lintJavascriptTool);
  registry.register(waitForPortTool);
  registry.register(generate3dTool);
  for (const tool of gitTools) registry.register(tool);
}

export interface StatefulToolDeps {
  provider: LlmProvider;
  permissions: PermissionManager;
  ui: UIAdapter;
  model: string;
  cwd: string;
  browser: BrowserManager;
}

/**
 * Builtins that need a shared manager instance (task delegation needs the
 * registry itself; browser/background-process/python-repl/preview_html each
 * own a long-lived resource reused across calls in the session). Kept
 * separate from registerBuiltins so that function stays a flat list with no
 * constructor arguments — but both are called together from cli.ts, and
 * this is the single place that shows the full builtin tool surface.
 */
export function registerStatefulBuiltins(registry: ToolRegistry, deps: StatefulToolDeps): void {
  registry.register(createTaskTool({ ...deps, tools: registry }));
  for (const tool of createBrowserTools(deps.browser)) registry.register(tool);
  for (const tool of createBackgroundProcessTools(new BackgroundProcessManager())) registry.register(tool);
  registry.register(createPythonReplTool(new PythonReplManager()));
  // Shared between the two so a preview_html-opened file and a
  // create_artifact-opened file are served from the same origin/port.
  const previewServer = new PreviewServer();
  registry.register(createPreviewHtmlTool(previewServer));
  registry.register(createArtifactTool(previewServer));
}
