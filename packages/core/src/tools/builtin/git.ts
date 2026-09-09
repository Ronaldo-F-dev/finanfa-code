import { spawn } from "node:child_process";
import type { ToolDefinition, ToolResult } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";
import { truncateOrSpill, TRUNCATE_MEDIUM } from "../../util/truncate.js";

const TIMEOUT_MS = 15_000;
// Real gap found while reviewing this file for benchmark readiness: fetch/
// pull/push actually reach a remote over the network, unlike every other
// command here (all purely local) — a real OSS repo (the kind SWE-bench-
// style benchmarks use) can easily take longer than 15s to fetch/push,
// which would have failed as a false "timed out" on a merely slow
// connection, not a genuinely stuck command.
const NETWORK_TIMEOUT_MS = 120_000;

/**
 * Runs `git <args>` in `cwd` via spawn with an argv array (never a shell) —
 * paths and messages reach git as discrete argv entries, so nothing a model
 * puts in a diff path or commit message can be interpreted as a shell
 * command, unlike the general-purpose `bash` tool.
 */
function runGit(cwd: string, sessionId: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<ToolResult> {
  return new Promise((resolve) => {
    // Force the C locale so output (status labels, etc.) is consistent and
    // parseable regardless of the host machine's configured locale.
    const child = spawn("git", args, { cwd, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ content: `git ${args.join(" ")} timed out after ${timeoutMs}ms`, isError: true });
        return;
      }
      void (async () => {
        const raw = stdout.trim().length > 0 ? stdout.trim() : stderr.trim() || "(no output)";
        const content = await truncateOrSpill(cwd, sessionId, "git", raw, TRUNCATE_MEDIUM);
        resolve({ content, isError: code !== 0 });
      })();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ content: `Failed to run git: ${err.message}`, isError: true });
    });
  });
}

function relativePaths(cwd: string, paths: string[]): string[] {
  return paths.map((p) => {
    resolveAllowedPath(cwd, p); // throws if it escapes cwd
    return p;
  });
}

export const gitStatus: ToolDefinition<Record<string, never>> = {
  name: "git_status",
  description: "Show the working tree status (staged, unstaged, and untracked changes).",
  riskLevel: "safe",
  inputSchema: { type: "object", properties: {} },
  describeCall: () => "status",
  handler: (_input, ctx) => runGit(ctx.cwd, ctx.sessionId, ["status"]),
};

interface GitDiffInput {
  path?: string;
  staged?: boolean;
}

export const gitDiff: ToolDefinition<GitDiffInput> = {
  name: "git_diff",
  description: "Show unstaged changes (or staged changes, with staged: true), optionally scoped to one path.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Limit the diff to this file, relative to the project root" },
      staged: { type: "boolean", description: "Show staged changes instead of unstaged ones" },
    },
  },
  describeCall: (input) => `diff${input.staged ? " --staged" : ""}${input.path ? ` -- ${input.path}` : ""}`,
  async handler(input, ctx) {
    const args = ["diff"];
    if (input.staged) args.push("--staged");
    if (input.path) args.push("--", ...relativePaths(ctx.cwd, [input.path]));
    return runGit(ctx.cwd, ctx.sessionId, args);
  },
};

interface GitLogInput {
  limit?: number;
}

export const gitLog: ToolDefinition<GitLogInput> = {
  name: "git_log",
  description: "Show recent commits (one line each).",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "number", description: "Max commits to show (default 20)" } },
  },
  describeCall: (input) => `log -n ${input.limit ?? 20}`,
  handler: (input, ctx) => runGit(ctx.cwd, ctx.sessionId, ["log", "--oneline", "-n", String(input.limit ?? 20)]),
};

export const gitBranch: ToolDefinition<Record<string, never>> = {
  name: "git_branch",
  description: "List local branches, with the current one marked and its latest commit shown.",
  riskLevel: "safe",
  inputSchema: { type: "object", properties: {} },
  describeCall: () => "list branches",
  handler: (_input, ctx) => runGit(ctx.cwd, ctx.sessionId, ["branch", "-vv"]),
};

interface GitAddInput {
  paths: string[];
}

export const gitAdd: ToolDefinition<GitAddInput> = {
  name: "git_add",
  description: "Stage one or more files for the next commit.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description: "File paths to stage, relative to the project root",
      },
    },
    required: ["paths"],
  },
  describeCall: (input) => `add ${input.paths.join(" ")}`,
  async handler(input, ctx) {
    if (input.paths.length === 0) return { content: "No paths given.", isError: true };
    return runGit(ctx.cwd, ctx.sessionId, ["add", "--", ...relativePaths(ctx.cwd, input.paths)]);
  },
};

interface GitCommitInput {
  message: string;
}

export const gitCommit: ToolDefinition<GitCommitInput> = {
  name: "git_commit",
  description: "Commit currently staged changes (run git_add first). Does not push.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string", description: "Commit message" } },
    required: ["message"],
  },
  describeCall: (input) => `commit: "${input.message}"`,
  async handler(input, ctx) {
    if (input.message.trim() === "") {
      return { content: "Commit message cannot be empty.", isError: true };
    }
    // Real gap found while reviewing this file for benchmark readiness: a
    // fresh sandboxed environment (the kind SWE-bench-style benchmarks run
    // in) typically has no ~/.gitconfig at all — confirmed by reproducing
    // it directly: `git commit` fails outright ("Please tell me who you
    // are", exit 128) with neither global nor repo identity configured.
    // Only falls back when nothing is already configured, so an identity
    // the user (or repo) actually set is never silently overridden.
    const email = await runGit(ctx.cwd, ctx.sessionId, ["config", "user.email"]);
    const args = email.isError
      ? ["-c", "user.name=finanfa-code", "-c", "user.email=agent@finanfa.local", "commit", "-m", input.message]
      : ["commit", "-m", input.message];
    return runGit(ctx.cwd, ctx.sessionId, args);
  },
};

interface GitCheckoutInput {
  branch: string;
  create?: boolean;
}

export const gitCheckout: ToolDefinition<GitCheckoutInput> = {
  name: "git_checkout",
  description: "Switch to an existing branch, or create and switch to a new one (create: true).",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      branch: { type: "string", description: "Branch name" },
      create: { type: "boolean", description: "Create the branch if it doesn't exist yet" },
    },
    required: ["branch"],
  },
  riskKey: (input) => input.branch,
  describeCall: (input) => (input.create ? `create and switch to branch "${input.branch}"` : `switch to branch "${input.branch}"`),
  handler: (input, ctx) => runGit(ctx.cwd, ctx.sessionId, input.create ? ["checkout", "-b", input.branch] : ["checkout", input.branch]),
};

interface GitPushInput {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
}

export const gitPush: ToolDefinition<GitPushInput> = {
  name: "git_push",
  description:
    "Push the current branch to a remote (default: origin). Use setUpstream: true the first time you push a " +
    "newly created branch. Never force-pushes — there's no force option, by design.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      remote: { type: "string", description: 'Remote name (default: "origin")' },
      branch: { type: "string", description: "Branch to push (default: the current branch)" },
      setUpstream: { type: "boolean", description: "Set upstream tracking (-u) — needed the first push of a new branch" },
    },
  },
  riskKey: (input) => input.branch ?? "current-branch",
  describeCall: (input) => `push ${input.branch ?? "current branch"} to ${input.remote ?? "origin"}`,
  async handler(input, ctx) {
    // `git push -u origin` with no explicit branch fails outright the first
    // time a new branch is pushed ("no upstream branch") — always resolve
    // and name the branch explicitly rather than relying on git's implicit
    // current-branch resolution, which behaves differently depending on
    // whether upstream tracking already exists.
    let branch = input.branch;
    if (!branch) {
      const current = await runGit(ctx.cwd, ctx.sessionId, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (current.isError) return current;
      branch = current.content.trim();
    }
    const args = ["push"];
    if (input.setUpstream) args.push("-u");
    args.push(input.remote ?? "origin", branch);
    return runGit(ctx.cwd, ctx.sessionId, args, NETWORK_TIMEOUT_MS);
  },
};

interface GitFetchInput {
  remote?: string;
}

export const gitFetch: ToolDefinition<GitFetchInput> = {
  name: "git_fetch",
  description: "Download objects and refs from a remote (default: origin), updating remote-tracking branches. Doesn't touch the working tree or local branches.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: { remote: { type: "string", description: 'Remote name (default: "origin")' } },
  },
  describeCall: (input) => `fetch ${input.remote ?? "origin"}`,
  handler: (input, ctx) => runGit(ctx.cwd, ctx.sessionId, ["fetch", input.remote ?? "origin"], NETWORK_TIMEOUT_MS),
};

interface GitPullInput {
  remote?: string;
  branch?: string;
}

export const gitPull: ToolDefinition<GitPullInput> = {
  name: "git_pull",
  description: "Fetch and merge/fast-forward the current branch from a remote (default: origin/current branch).",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      remote: { type: "string", description: 'Remote name (default: "origin")' },
      branch: { type: "string", description: "Branch to pull (default: the current branch's own tracking config)" },
    },
  },
  riskKey: (input) => input.branch ?? "current-branch",
  describeCall: (input) => `pull ${[input.remote ?? "origin", input.branch].filter(Boolean).join(" ")}`,
  handler: (input, ctx) => {
    const args = ["pull", input.remote ?? "origin"];
    if (input.branch) args.push(input.branch);
    return runGit(ctx.cwd, ctx.sessionId, args, NETWORK_TIMEOUT_MS);
  },
};

interface GitStashInput {
  action?: "push" | "pop" | "list" | "drop";
  message?: string;
}

export const gitStash: ToolDefinition<GitStashInput> = {
  name: "git_stash",
  description: 'Stash working-tree changes ("push", the default), or "pop"/"list"/"drop" them.',
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["push", "pop", "list", "drop"], description: 'Default "push"' },
      message: { type: "string", description: 'Optional label, only used with action "push"' },
    },
  },
  riskKey: (input) => input.action ?? "push",
  describeCall: (input) => `stash ${input.action ?? "push"}`,
  handler: (input, ctx) => {
    const action = input.action ?? "push";
    const args: string[] = ["stash", action];
    if (action === "push" && input.message) args.push("-m", input.message);
    return runGit(ctx.cwd, ctx.sessionId, args);
  },
};

interface GitResetInput {
  paths?: string[];
  hard?: boolean;
  ref?: string;
}

// Real gap found while reviewing this file for benchmark readiness: there
// was no way to unstage a mistaken `git_add`, or throw away uncommitted
// changes to retry cleanly — every other real git workflow needs at least
// one of those, and a benchmark run has no human around to drop to a
// terminal for it.
export const gitReset: ToolDefinition<GitResetInput> = {
  name: "git_reset",
  description:
    "Unstage one or more files (paths, keeps working-tree edits), or with hard: true, discard ALL uncommitted " +
    "changes and reset to ref (default HEAD) — destructive, use git_stash instead if the changes might still be needed.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "Files to unstage, relative to the project root — omit for a full/hard reset" },
      hard: { type: "boolean", description: "Discard uncommitted changes entirely instead of just unstaging" },
      ref: { type: "string", description: 'Only with hard: true — reset to this ref instead of HEAD (default "HEAD")' },
    },
  },
  riskKey: (input) => (input.hard ? "hard" : "unstage"),
  describeCall: (input) =>
    input.hard ? `reset --hard ${input.ref ?? "HEAD"} (discards uncommitted changes)` : `unstage ${input.paths?.join(" ") ?? "everything"}`,
  async handler(input, ctx) {
    if (input.hard) return runGit(ctx.cwd, ctx.sessionId, ["reset", "--hard", input.ref ?? "HEAD"]);
    const args = ["reset"];
    if (input.paths && input.paths.length > 0) args.push("--", ...relativePaths(ctx.cwd, input.paths));
    return runGit(ctx.cwd, ctx.sessionId, args);
  },
};

export const gitTools: ToolDefinition[] = [
  gitStatus,
  gitDiff,
  gitLog,
  gitBranch,
  gitAdd,
  gitCommit,
  gitReset,
  gitCheckout,
  gitPush,
  gitFetch,
  gitPull,
  gitStash,
];
