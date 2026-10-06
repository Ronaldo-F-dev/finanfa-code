import { MCP_TOOL_PREFIX } from "../mcp/client-manager.js";

// Broad groups of tools a user can approve in one go ("let it edit files without asking") instead of one prompt per call.
// Deliberately small and conservative: a category only ever covers what its name says.

export const APPROVAL_CATEGORIES = ["edits", "terminal", "mcp"] as const;
export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number];
export type AutoApproveSettings = Partial<Record<ApprovalCategory, boolean>>;

/** Tools that change files of the project in place. Creating, moving or deleting through git, a build tool or a shell is NOT here — that is `terminal`. */
const EDIT_TOOLS = new Set(["write_file", "edit_file", "multi_edit_file", "edit_notebook", "write_document", "edit_document", "write_spreadsheet", "edit_spreadsheet"]);

/** Tools that run commands on THIS machine. Remote hosts, containers, cloud and deployment tools are not here: reaching further out than the local shell is a separate decision. */
const TERMINAL_TOOLS = new Set(["bash", "python_repl", "start_background_process", "tmux_new_session", "tmux_send_keys"]);

/** Which approval category a tool belongs to, if any. */
export function approvalCategoryOf(toolName: string): ApprovalCategory | undefined {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return "mcp";
  if (EDIT_TOOLS.has(toolName)) return "edits";
  if (TERMINAL_TOOLS.has(toolName)) return "terminal";
  return undefined;
}

/** Reads settings from untrusted JSON: only the known categories, only literal `true`/`false`. */
export function parseAutoApprove(value: unknown): AutoApproveSettings {
  const settings: AutoApproveSettings = {};
  if (!value || typeof value !== "object") return settings;
  for (const category of APPROVAL_CATEGORIES) {
    const v = (value as Record<string, unknown>)[category];
    if (typeof v === "boolean") settings[category] = v;
  }
  return settings;
}
