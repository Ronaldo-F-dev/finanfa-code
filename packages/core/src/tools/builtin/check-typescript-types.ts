import { access } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

const DEFAULT_TIMEOUT_MS = 120_000;

async function hasTsconfig(cwd: string): Promise<boolean> {
  try {
    await access(path.join(cwd, "tsconfig.json"));
    return true;
  } catch {
    return false;
  }
}

interface CheckTypescriptTypesInput {
  timeout_ms?: number;
}

export const checkTypescriptTypesTool: ToolDefinition<CheckTypescriptTypesInput> = {
  name: "check_typescript_types",
  description:
    "Run the TypeScript compiler (tsc --noEmit) on this project and report the errors, the same way " +
    "check_python_types reports Pyright's. Always whole-project, not scoped to a path — unlike Pyright/ESLint, " +
    "tsc refuses to combine a project's tsconfig.json with a file given on the command line (verified " +
    "directly: it errors with \"tsconfig.json is present but will not be loaded if files are specified on " +
    "commandline\"), so there's no reliable way to check just one file with the real project config applied.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 120000)" },
    },
  },
  describeCall: () => "check_typescript_types (whole project)",
  async handler(input, ctx) {
    if (!(await hasTsconfig(ctx.cwd))) {
      return { content: "No tsconfig.json found in this project — tsc has nothing to check against.", isError: true };
    }

    // `npx tsc` resolves to an unrelated squatted npm package (a stub with a
    // warning message, "This is not the tsc command you are looking for"),
    // NOT the real TypeScript compiler (verified directly) — the explicit
    // --package= form is what actually gets the real one. npx prefers a
    // project's own locally installed typescript over fetching latest, same
    // as check_python_types/lint_javascript's npx usage.
    return runSubprocess("npx", {
      args: ["-y", "--package=typescript", "tsc", "--noEmit"],
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      signal: ctx.signal,
      format: "compact",
      // tsc exits 1 for type errors and 0 when clean (verified directly) —
      // same convention as Pyright/ESLint. tsc also exits 1 for a genuinely
      // invalid CLI flag, which isn't distinguishable by exit code alone,
      // but this tool never passes one through from the caller, so in
      // practice a 1 here always means real type errors.
      isError: (code) => code !== 0 && code !== 1,
    });
  },
};
