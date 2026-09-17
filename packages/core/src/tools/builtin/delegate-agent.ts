import type { ToolContext, ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

// Delegates a real coding task to another, already-installed coding-agent
// CLI (Claude Code, OpenAI's Codex) running as its own real subprocess in
// a given directory — a genuinely different capability from the `task`
// tool (which only ever spawns a sub-agent inside THIS project's own
// engine): this hands the work to a completely separate agent, with its
// own model/tools/context, useful for comparing approaches or offloading
// work to whichever tool the user already has configured for a
// particular kind of task. A thin, generic argv-passthrough wrapper
// (same shape as run_mydevops.ts) rather than a rigid "just take a
// prompt" abstraction — each CLI's own real flags (headless/print mode,
// auto-approval policy, model selection, ...) change across versions, so
// `--help` on the real binary is the source of truth, not a hardcoded
// guess baked in here.
const DEFAULT_TIMEOUT_MS = 600_000; // a real delegated coding task can run far longer than a typical bash call

export interface DelegateAgentToolOptions {
  binary?: string;
}

interface DelegateAgentInput {
  args: string[];
  cwd?: string;
  timeout_ms?: number;
}

async function runDelegatedAgent(binary: string, input: DelegateAgentInput, ctx: ToolContext) {
  const cwd = input.cwd ? `${ctx.cwd}/${input.cwd}` : ctx.cwd;
  const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  return runSubprocess(binary, { cwd, sessionId: ctx.sessionId, timeoutMs, signal: ctx.signal, args: input.args });
}

export function createDelegateToClaudeCodeTool(options: DelegateAgentToolOptions = {}): ToolDefinition<DelegateAgentInput> {
  const binary = options.binary ?? "claude";
  return {
    name: "delegate_to_claude_code",
    description:
      "Delegate a real coding task to the user's own already-installed Claude Code CLI (`claude`), running as " +
      "a separate agent in a given directory — not a sub-agent of this session, a genuinely different tool with " +
      "its own model/context. Pass real CLI args (e.g. ['-p', 'fix the failing test in foo.test.ts', " +
      "'--output-format', 'text'] for its non-interactive print mode) — check `claude --help` first if unsure " +
      "of current flags, since they can change across versions. " +
      "IMPORTANT: this runs a real, separate coding agent with its own tool access in the given directory — " +
      "confirm what it's about to do with the user before calling this unless they've explicitly asked for it.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, description: "Real argv for the claude CLI, e.g. ['-p', '<task>', '--output-format', 'text']" },
        cwd: { type: "string", description: "Working directory to run claude in, relative to the project root (defaults to the project root)" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 600000 — a real delegated task can run long)" },
      },
      required: ["args"],
    },
    describeCall: (input) => `delegate to claude code: ${input.args.join(" ")}`,
    async handler(input, ctx) {
      return runDelegatedAgent(binary, input, ctx);
    },
  };
}

export function createDelegateToCodexTool(options: DelegateAgentToolOptions = {}): ToolDefinition<DelegateAgentInput> {
  const binary = options.binary ?? "codex";
  return {
    name: "delegate_to_codex",
    description:
      "Delegate a real coding task to the user's own already-installed OpenAI Codex CLI (`codex`), running as " +
      "a separate agent in a given directory — not a sub-agent of this session, a genuinely different tool with " +
      "its own model/context. Pass real CLI args (e.g. ['exec', 'fix the failing test in foo.test.ts'] for its " +
      "non-interactive exec mode) — check `codex --help` first if unsure of current flags, since they can " +
      "change across versions. " +
      "IMPORTANT: this runs a real, separate coding agent with its own tool access in the given directory — " +
      "confirm what it's about to do with the user before calling this unless they've explicitly asked for it.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, description: "Real argv for the codex CLI, e.g. ['exec', '<task>']" },
        cwd: { type: "string", description: "Working directory to run codex in, relative to the project root (defaults to the project root)" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 600000 — a real delegated task can run long)" },
      },
      required: ["args"],
    },
    describeCall: (input) => `delegate to codex: ${input.args.join(" ")}`,
    async handler(input, ctx) {
      return runDelegatedAgent(binary, input, ctx);
    },
  };
}
