import type { ToolDefinition } from "../../core/types.js";
import type { PythonReplManager } from "../../core/python-repl.js";

const DEFAULT_TIMEOUT_MS = 30_000;

interface PythonReplInput {
  code?: string;
  reset?: boolean;
  timeout_ms?: number;
}

/**
 * A single persistent Python session per finanfa-code run — the point of a
 * REPL over `bash: python3 -c "..."` is that variables/imports/function defs
 * survive across calls. Session-scoped only, same as background processes:
 * a fresh run starts with a clean namespace.
 */
export function createPythonReplTool(manager: PythonReplManager): ToolDefinition<PythonReplInput> {
  return {
    name: "python_repl",
    description:
      "Run Python code in a persistent session — variables, imports, and function defs from earlier calls " +
      "are still there, unlike `bash: python3 -c \"...\"` which starts fresh every time. The value of the " +
      "last expression (if any) is returned, same as typing it in an interactive shell. Pass reset: true to " +
      "clear the session and start over (e.g. after an infinite loop forced a timeout-triggered restart, or " +
      "just to start clean). Calling input() will hang — there's no interactive stdin here.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python code to run in the persistent session" },
        reset: { type: "boolean", description: "Clear the session (all variables/imports lost) before running code, if any" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 30000)" },
      },
    },
    riskKey: () => "python_repl",
    describeCall: (input) => (input.reset && !input.code ? "reset Python REPL session" : `python_repl: ${input.code ?? ""}`),
    async handler(input, ctx) {
      if (input.reset) manager.reset();
      if (!input.code) {
        return { content: input.reset ? "Session reset." : "No code given.", isError: !input.reset };
      }

      const result = await manager.run(input.code, input.timeout_ms ?? DEFAULT_TIMEOUT_MS, ctx.cwd, ctx.sessionId);
      if (result.timedOut) {
        return {
          content: `Timed out after ${input.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms — the session was killed and will restart fresh on the next call (state lost).`,
          isError: true,
        };
      }

      const parts: string[] = [];
      if (result.stdout) parts.push(result.stdout.replace(/\n$/, ""));
      if (result.stderr) parts.push(`--- stderr ---\n${result.stderr.replace(/\n$/, "")}`);
      if (result.error) parts.push(result.error.replace(/\n$/, ""));
      else if (result.result !== null) parts.push(result.result);

      return { content: parts.join("\n") || "(no output)", isError: result.error !== null };
    },
  };
}
