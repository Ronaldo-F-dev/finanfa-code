import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { killProcessGroup, SHELL } from "../../util/process.js";
import { resolveAllowedPath } from "./path-guard.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 100_000;

const CONFIG_FILENAMES = [
  // Flat config (ESLint v9+, the default this tool's `npx eslint` will use
  // unless the project has its own older eslint installed locally).
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  // Legacy config (ESLint v8 and earlier) — still relevant since npx prefers
  // a project's own locally installed eslint version over fetching latest.
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  ".eslintrc.json",
];

function truncate(s: string): string {
  return s.length > MAX_BUFFER ? `${s.slice(0, MAX_BUFFER)}\n... (truncated)` : s;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function hasEslintConfig(cwd: string): Promise<boolean> {
  for (const name of CONFIG_FILENAMES) {
    if (await exists(path.join(cwd, name))) return true;
  }
  return false;
}

interface LintJavascriptInput {
  path?: string;
  timeout_ms?: number;
}

export const lintJavascriptTool: ToolDefinition<LintJavascriptInput> = {
  name: "lint_javascript",
  description:
    "Run ESLint on a JavaScript/TypeScript file or project and report the errors/warnings, the same way " +
    "run_tests reports test failures. Uses `npx eslint` — no separate install needed if the project already " +
    "has one, otherwise npx fetches the latest ESLint. Unlike check_python_types/Pyright, this needs the " +
    "project to already have its own ESLint config (eslint.config.js or legacy .eslintrc.*) — ESLint refuses " +
    "to run at all without one (verified directly), so this won't try to impose one of its own.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory to lint (default: the whole project)" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 120000)" },
    },
  },
  describeCall: (input) => `lint_javascript ${input.path ?? "(whole project)"}`,
  async handler(input, ctx) {
    const target = input.path ? resolveAllowedPath(ctx.cwd, input.path) : ctx.cwd;

    if (!(await hasEslintConfig(ctx.cwd))) {
      return {
        content:
          "No ESLint config found in this project (no eslint.config.js/mjs/cjs/ts or legacy .eslintrc.*). " +
          "Set one up first (e.g. `npm init @eslint/config`) — unlike Pyright, ESLint has no usable defaults " +
          "and refuses to run without a config.",
        isError: true,
      };
    }

    return new Promise((resolve) => {
      // detached: true / killProcessGroup — same reasoning as run_tests/
      // check_python_types: a hung or backgrounding subprocess shouldn't be
      // able to hold this call open past the configured timeout.
      const child = spawn("npx", ["-y", "eslint", target], { cwd: ctx.cwd, shell: SHELL, detached: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child);
      }, timeoutMs);

      child.stdout?.on("data", (d) => (stdout += d));
      child.stderr?.on("data", (d) => (stderr += d));

      child.on("close", (code) => {
        clearTimeout(timer);
        const header = timedOut ? `(timed out after ${timeoutMs}ms)\n` : `(exit code ${code})\n`;
        const content = `${header}${truncate(stdout)}${stderr ? `\n--- stderr ---\n${truncate(stderr)}` : ""}`;
        // ESLint exits 1 when it finds at least one error (not a tool
        // failure, same as Pyright's exit 1) and 0 when clean or
        // warnings-only (verified directly) — any other code (e.g. 2, a
        // missing/invalid config or bad file pattern) is a genuine failure.
        resolve({ content, isError: timedOut || (code !== 0 && code !== 1) });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ content: `Failed to start eslint: ${err.message}`, isError: true });
      });
    });
  },
};
