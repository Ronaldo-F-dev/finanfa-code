import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

// Shared "wrap a real external CLI as a subcommand-passthrough tool"
// factory — the pattern run_mydevops/run_esptool/run_avrdude/
// run_arduino_cli/run_platformio all use: real argv (never a shell
// string), injectable binary name (so tests can point it at a fake
// stand-in instead of requiring the real tool installed everywhere this
// runs), riskKey scoped per subcommand so a user can allow-list read-only
// subcommands without blanket-approving a genuinely destructive one.
export function createGenericCliTool(
  toolName: string,
  binaryDefault: string,
  description: string,
  opts: { binaryOverride?: string; riskLevel?: "ask" | "dangerous"; defaultTimeoutMs?: number } = {},
): ToolDefinition<{ args: string[]; cwd?: string; timeout_ms?: number }> {
  const binary = opts.binaryOverride ?? binaryDefault;
  const riskLevel = opts.riskLevel ?? "dangerous";
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;

  return {
    name: toolName,
    description,
    riskLevel,
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, description: "Arguments/flags, as a plain array (never a shell string)" },
        cwd: { type: "string", description: "Working directory, relative to the project root (defaults to the project root)" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${defaultTimeoutMs})` },
      },
      required: ["args"],
    },
    riskKey: (input) => `${toolName}:${input.args[0] ?? ""}`,
    describeCall: (input) => `${binaryDefault} ${input.args.join(" ")}`,
    async handler(input, ctx) {
      const cwd = input.cwd ? `${ctx.cwd}/${input.cwd}` : ctx.cwd;
      return runSubprocess(binary, { cwd, sessionId: ctx.sessionId, timeoutMs: input.timeout_ms ?? defaultTimeoutMs, signal: ctx.signal, args: input.args });
    },
  };
}
