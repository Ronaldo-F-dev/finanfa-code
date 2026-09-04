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

interface CheckPythonTypesInput {
  path?: string;
  timeout_ms?: number;
}

export const checkPythonTypesTool: ToolDefinition<CheckPythonTypesInput> = {
  name: "check_python_types",
  description:
    "Run Pyright to type-check a Python file or project and report the errors/warnings, the same way " +
    "run_tests reports test failures. Uses `npx pyright` — no separate pip install needed, it's an npm " +
    "package. Static analysis only, doesn't execute any code.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory to check (default: the whole project)" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 120000)" },
    },
  },
  describeCall: (input) => `check_python_types ${input.path ?? "(whole project)"}`,
  async handler(input, ctx) {
    const target = input.path ? resolveAllowedPath(ctx.cwd, input.path) : ctx.cwd;

    if (!(await looksLikePythonProject(ctx.cwd))) {
      return {
        content: "No Python project detected here (no pyproject.toml/setup.py/requirements.txt or .py files).",
        isError: true,
      };
    }

    // pyright exits 1 when it finds type errors (not a tool failure) and 0
    // when clean — either way that's a successful run to report back.
    return runSubprocess("npx", {
      args: ["-y", "pyright", target],
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      format: "compact",
      isError: (code) => code !== 0 && code !== 1,
    });
  },
};
