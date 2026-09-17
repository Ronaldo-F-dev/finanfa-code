import type { ToolDefinition } from "../../core/types.js";
import { exportClawBundle, installClawBundle, listClawSnapshots, rollbackClawSnapshot, clawSnapshotExists, type ClawBundle } from "../../core/claw-bundle.js";

interface ExportBundleInput {
  name: string;
  version: string;
  description?: string;
}

export const exportBundleTool: ToolDefinition<ExportBundleInput> = {
  name: "export_bundle",
  description:
    "Export this project's finanfa-code configuration (permission rules/hooks, MCP servers, memory, skills, " +
    "commands, agent types, path-scoped instructions, finanfa.md/finanfa-design.md — everything under " +
    "`.finanfa-code/` plus those two root files) as one shareable, versioned bundle (JSON). Hand the output to " +
    "someone else to set up an identical project configuration via install_bundle, or keep it as a labeled " +
    "checkpoint of the current setup.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: 'Bundle name, e.g. "acme-corp-conventions"' },
      version: { type: "string", description: 'Version string, e.g. "1.0.0"' },
      description: { type: "string" },
    },
    required: ["name", "version"],
  },
  describeCall: (input) => `export bundle "${input.name}@${input.version}"`,
  async handler(input, ctx) {
    const bundle = await exportClawBundle(ctx.cwd, input);
    const fileCount = Object.keys(bundle.files).length;
    if (fileCount === 0) return { content: "Nothing to bundle — this project has no .finanfa-code/ config yet.", isError: false };
    return { content: JSON.stringify(bundle, null, 2), isError: false };
  },
};

interface InstallBundleInput {
  bundle_json: string;
}

export const installBundleTool: ToolDefinition<InstallBundleInput> = {
  name: "install_bundle",
  description:
    "Install a bundle (from export_bundle, or shared by someone else) into this project — writes its " +
    "settings.json/memory/skills/commands/agents/instructions/mcp.json/finanfa.md files into `.finanfa-code/` " +
    "and the project root, OVERWRITING any existing file at the same path. The exact previous content of every " +
    "file it touches is snapshotted first (see list_bundle_snapshots/rollback_bundle) so this can be undone. " +
    "IMPORTANT: a bundle's settings.json can include PreToolUse/PostToolUse/UserPromptSubmit hooks — arbitrary " +
    "shell commands that run automatically once this project is trusted. Only install a bundle from a source " +
    "the user actually trusts, and confirm with them first.",
  riskLevel: "dangerous",
  inputSchema: {
    type: "object",
    properties: { bundle_json: { type: "string", description: "The bundle's JSON, exactly as export_bundle produced it" } },
    required: ["bundle_json"],
  },
  describeCall: (input) => {
    try {
      const bundle = JSON.parse(input.bundle_json) as ClawBundle;
      return `install bundle "${bundle.manifest.name}@${bundle.manifest.version}" (${Object.keys(bundle.files).length} file(s))`;
    } catch {
      return "install bundle (unparseable JSON — will fail)";
    }
  },
  async handler(input, ctx) {
    let bundle: ClawBundle;
    try {
      bundle = JSON.parse(input.bundle_json) as ClawBundle;
    } catch (err) {
      return { content: `Not valid bundle JSON: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    if (!bundle.manifest?.name || !bundle.files) {
      return { content: "Not a valid bundle — missing manifest.name or files.", isError: true };
    }
    const result = await installClawBundle(ctx.cwd, bundle);
    return {
      content: `Installed "${bundle.manifest.name}@${bundle.manifest.version}" — ${result.filesWritten.length} file(s) written. Snapshot "${result.snapshotId}" saved beforehand — use rollback_bundle to undo.`,
      isError: false,
    };
  },
};

export const listBundleSnapshotsTool: ToolDefinition<Record<string, never>> = {
  name: "list_bundle_snapshots",
  description: "List every install_bundle snapshot recorded for this project (most recent first), each usable with rollback_bundle to undo that install.",
  riskLevel: "safe",
  inputSchema: { type: "object", properties: {} },
  async handler(_input, ctx) {
    const snapshots = await listClawSnapshots(ctx.cwd);
    if (snapshots.length === 0) return { content: "No bundle install snapshots recorded for this project.", isError: false };
    return { content: snapshots.map((s) => `${s.id} — ${s.createdAt} — ${s.reason}`).join("\n"), isError: false };
  },
};

interface RollbackBundleInput {
  snapshot_id: string;
}

export const rollbackBundleTool: ToolDefinition<RollbackBundleInput> = {
  name: "rollback_bundle",
  description: "Undo a previous install_bundle by restoring every file it touched back to its exact prior content (or deleting it, if it didn't exist before). See list_bundle_snapshots for the id.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { snapshot_id: { type: "string", description: "A snapshot id from list_bundle_snapshots" } },
    required: ["snapshot_id"],
  },
  describeCall: (input) => `rollback bundle snapshot ${input.snapshot_id}`,
  async handler(input, ctx) {
    if (!(await clawSnapshotExists(ctx.cwd, input.snapshot_id))) {
      return { content: `No bundle snapshot "${input.snapshot_id}" for this project — see list_bundle_snapshots.`, isError: true };
    }
    await rollbackClawSnapshot(ctx.cwd, input.snapshot_id);
    return { content: `Rolled back to before snapshot "${input.snapshot_id}".`, isError: false };
  },
};
