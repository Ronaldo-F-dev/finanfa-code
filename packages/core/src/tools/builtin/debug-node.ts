import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

// Real post-mortem Node.js debugging — runs a script under a small runner
// that, on an uncaught exception/rejection, prints the full stack trace
// AND the error's own properties beyond just message/stack (`.cause`
// chains, `AggregateError.errors`, any custom fields a caller attached) —
// a plain `node script.js` run only ever prints the default
// message+stack, silently dropping the rest. Unlike Python, Node gives no
// safe, dependency-free way to read a failing frame's local *variable*
// values without attaching a real Chrome DevTools Protocol client to the
// process — out of scope here; for genuinely interactive step-through
// debugging (breakpoints, watch expressions, live scope inspection), use
// `node inspect <script>` inside a tmux session instead
// (tmux_new_session/tmux_send_keys).
const DEFAULT_TIMEOUT_MS = 60_000;

export interface DebugNodeToolOptions {
  binary?: string;
}

interface DebugNodeTracebackInput {
  script: string;
  args?: string[];
  cwd?: string;
  timeout_ms?: number;
}

// process.argv[0] is the node binary, [1] this runner script, [2] the
// target script, [3:] its own args — reassembled below (via
// process.argv.splice) so the target script's own argument parsing sees
// the same argv shape a normal `node script.js` invocation would give it.
const RUNNER_CODE = `
import { pathToFileURL } from "node:url";

function describeError(err) {
  if (!(err instanceof Error)) return String(err);
  const lines = [err.stack ?? String(err)];
  const extraKeys = Object.keys(err).filter((k) => k !== "message" && k !== "stack");
  if (extraKeys.length > 0) {
    lines.push("--- Additional error properties ---");
    for (const key of extraKeys) {
      let rendered;
      try {
        rendered = JSON.stringify(err[key]);
      } catch {
        rendered = String(err[key]);
      }
      lines.push(\`\${key} = \${rendered}\`);
    }
  }
  if (err.cause !== undefined) {
    lines.push("--- Caused by ---");
    lines.push(describeError(err.cause));
  }
  if (err instanceof AggregateError && Array.isArray(err.errors)) {
    lines.push(\`--- \${err.errors.length} aggregated error(s) ---\`);
    for (const inner of err.errors) lines.push(describeError(inner));
  }
  return lines.join("\\n");
}

process.on("uncaughtException", (err) => {
  console.error(describeError(err));
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(describeError(err));
  process.exit(1);
});

const script = process.argv[2];
process.argv.splice(1, 1); // drop this runner's own path — argv becomes [node, script, ...args]
await import(pathToFileURL(script).href);
`;

export function createDebugNodeTracebackTool(options: DebugNodeToolOptions = {}): ToolDefinition<DebugNodeTracebackInput> {
  const binary = options.binary ?? "node";
  return {
    name: "debug_node_traceback",
    description:
      "Run a real Node.js script; if it throws an uncaught exception or unhandled rejection, capture the full " +
      "stack trace AND the error's own additional properties (`.cause` chains, `AggregateError.errors`, any " +
      "custom fields) — a plain `node script.js` run only shows message+stack. For genuinely interactive " +
      "step-through debugging (breakpoints, watch expressions, live scope inspection), run `node inspect " +
      "<script>` inside a tmux session instead (tmux_new_session/tmux_send_keys).",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Path to the Node.js script to run, relative to the project root" },
        args: { type: "array", items: { type: "string" }, description: "Arguments to pass to the script itself (as process.argv.slice(2))" },
        cwd: { type: "string", description: "Working directory to run the script from, relative to the project root (defaults to the project root)" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 60000)" },
      },
      required: ["script"],
    },
    describeCall: (input) => `debug node ${input.script}${input.args?.length ? ` ${input.args.join(" ")}` : ""}`,
    async handler(input, ctx) {
      const cwd = input.cwd ? `${ctx.cwd}/${input.cwd}` : ctx.cwd;
      const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;

      const runnerDir = await mkdtemp(path.join(tmpdir(), "finanfa-debug-node-runner-"));
      try {
        const runnerPath = path.join(runnerDir, "runner.mjs");
        await writeFile(runnerPath, RUNNER_CODE, "utf-8");
        return await runSubprocess(binary, {
          cwd,
          sessionId: ctx.sessionId,
          timeoutMs,
          signal: ctx.signal,
          args: [runnerPath, path.resolve(cwd, input.script), ...(input.args ?? [])],
        });
      } finally {
        await rm(runnerDir, { recursive: true, force: true });
      }
    },
  };
}
