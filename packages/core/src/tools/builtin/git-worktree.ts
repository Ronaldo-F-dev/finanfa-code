import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { runGit } from "./git.js";
import { resolveAllowedPath } from "./path-guard.js";

type WorktreeAction = "list" | "add" | "remove";

interface GitWorktreeInput {
  action: WorktreeAction;
  branch?: string;
  path?: string;
  create?: boolean;
  force?: boolean;
}

// A branch name becomes a git argv entry, so one starting with "-" would be
// parsed as an option. Same conservative charset git itself recommends.
const SAFE_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/** Sibling directory of the project: <project>-worktrees/<branch with "/" flattened>. Outside the repo, so the main working tree never sees it as untracked files. */
function defaultWorktreePath(cwd: string, branch: string): string {
  return path.join(path.dirname(cwd), `${path.basename(cwd)}-worktrees`, branch.replaceAll("/", "-"));
}

export const gitWorktree: ToolDefinition<GitWorktreeInput> = {
  name: "git_worktree",
  description:
    "Manage git worktrees: extra working directories of the same repository, each on its own branch — the way to work on " +
    "several changes in parallel (or hand a sub-task its own isolated checkout) without stashing or switching branches. " +
    "action 'list' shows them; 'add' creates one for `branch` (create: true makes a new branch) at `path` (default: a sibling " +
    "<project>-worktrees/<branch> directory); 'remove' deletes one by `path` (force: true discards uncommitted changes). " +
    "Run commands inside a worktree with bash (`cd <path> && ...`); this tool's own file/git tools keep working on the main project.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "add", "remove"], description: "What to do" },
      branch: { type: "string", description: "Branch to check out in the new worktree (add)" },
      path: { type: "string", description: "Worktree directory (add: where to create it; remove: which one to delete)" },
      create: { type: "boolean", description: "add: create `branch` as a new branch instead of checking out an existing one" },
      force: { type: "boolean", description: "remove: delete even with uncommitted changes" },
    },
    required: ["action"],
  },
  riskKey: (input) => input.action,
  describeCall: (input) => {
    if (input.action === "list") return "list worktrees";
    if (input.action === "add") return `add worktree for "${input.branch ?? "?"}"${input.path ? ` at ${input.path}` : ""}`;
    return `remove worktree ${input.path ?? "?"}${input.force ? " (force)" : ""}`;
  },
  async handler(input, ctx) {
    if (input.action === "list") return runGit(ctx.cwd, ctx.sessionId, ["worktree", "list"]);

    if (input.action === "add") {
      if (!input.branch || !SAFE_BRANCH.test(input.branch)) {
        return { content: "git_worktree add needs a `branch` made of letters, digits, '.', '_', '-' or '/' (and not starting with '-').", isError: true };
      }
      const target = resolveAllowedPath(ctx.cwd, input.path ?? defaultWorktreePath(ctx.cwd, input.branch));
      const args = input.create ? ["worktree", "add", "-b", input.branch, target] : ["worktree", "add", target, input.branch];
      const result = await runGit(ctx.cwd, ctx.sessionId, args);
      return result.isError ? result : { content: `Created worktree at ${target} on branch ${input.branch}.\n${result.content}`, isError: false };
    }

    if (input.action === "remove") {
      if (!input.path) return { content: "git_worktree remove needs the worktree's `path` (see action 'list').", isError: true };
      const target = resolveAllowedPath(ctx.cwd, input.path);
      return runGit(ctx.cwd, ctx.sessionId, ["worktree", "remove", ...(input.force ? ["--force"] : []), target]);
    }

    return { content: `Unknown action "${String(input.action)}" — use list, add or remove.`, isError: true };
  },
};
