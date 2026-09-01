import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";
import { resolveAllowedPath } from "./path-guard.js";

const DEFAULT_TIMEOUT_MS = 120_000;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function looksLikePythonProject(cwd: string): Promise<boolean> {
  if (
    (await exists(path.join(cwd, "pyproject.toml"))) ||
    (await exists(path.join(cwd, "setup.py"))) ||
    (await exists(path.join(cwd, "requirements.txt")))
  ) {
    return true;
  }
  try {
    const entries = await readdir(cwd);
    return entries.some((e) => e.endsWith(".py"));
  } catch {
    return false;
  }
}

function commandAvailable(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

// Unlike Pyright, ruff isn't published as an npm package — `npx ruff` has
// nothing to resolve. `uvx` (uv's own npx-equivalent, downloads and caches
// on demand) is the closest match, but uv itself isn't guaranteed to be
// installed the way npx is (npx ships with Node, which finanfa-code already
// depends on just to run). Falls back to an already-installed `ruff` on
// PATH; only errors if neither exists, with a message naming both options.
async function findRuffCommand(): Promise<{ command: string; args: string[] } | undefined> {
  if (await commandAvailable("ruff", ["--version"])) return { command: "ruff", args: [] };
  if (await commandAvailable("uvx", ["--version"])) return { command: "uvx", args: ["ruff"] };
  return undefined;
}

interface LintPythonInput {
  path?: string;
  timeout_ms?: number;
}

export const lintPythonTool: ToolDefinition<LintPythonInput> = {
  name: "lint_python",
  description:
    "Run ruff on a Python file or project and report the errors/warnings, the same way lint_javascript " +
    "reports ESLint's. Prefers an already-installed `ruff`, falling back to `uvx ruff` (uv's equivalent of " +
    "npx) if uv is installed — unlike Pyright, ruff isn't published as an npm package, so plain npx can't " +
    "fetch it.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory to lint (default: the whole project)" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 120000)" },
    },
  },
  describeCall: (input) => `lint_python ${input.path ?? "(whole project)"}`,
  async handler(input, ctx) {
    const target = input.path ? resolveAllowedPath(ctx.cwd, input.path) : ctx.cwd;

    if (!(await looksLikePythonProject(ctx.cwd))) {
      return {
        content: "No Python project detected here (no pyproject.toml/setup.py/requirements.txt or .py files).",
        isError: true,
      };
    }

    const runner = await findRuffCommand();
    if (!runner) {
      return {
        content:
          "ruff isn't available: no `ruff` on PATH, and no `uvx` (uv) to fetch it on demand. Install one — " +
          "`pip install ruff`, or install uv (https://docs.astral.sh/uv/) — then retry.",
        isError: true,
      };
    }

    // ruff exits 1 when it finds issues (not a tool failure, same
    // convention as Pyright/ESLint) and 0 when clean (verified directly).
    return runSubprocess(runner.command, {
      args: [...runner.args, "check", target],
      cwd: ctx.cwd,
      timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      format: "compact",
      isError: (code) => code !== 0 && code !== 1,
    });
  },
};
