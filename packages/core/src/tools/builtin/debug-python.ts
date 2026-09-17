import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

// Real post-mortem Python debugging — runs a script under a small runner
// that, on an uncaught exception, prints the full traceback AND the local
// variables of the innermost (failing) frame. bash.ts already lets the
// agent run `python3 script.py` and see whatever it prints, but a plain
// traceback names the failing line without showing what any variable
// actually held at that point — this is the real gap pdb/debugpy close
// for a human, and this tool closes the same gap without needing an
// interactive back-and-forth (tmux.ts's tools cover that instead, for
// when true step-through interaction is actually needed: `python3 -m pdb
// <script>` inside a tmux session, stepped with tmux_send_keys).
const DEFAULT_TIMEOUT_MS = 60_000;

export interface DebugPythonToolOptions {
  binary?: string;
}

interface DebugPythonTracebackInput {
  script: string;
  args?: string[];
  cwd?: string;
  timeout_ms?: number;
}

// sys.argv[1] is the target script path, sys.argv[2:] its own args (this
// runner is itself invoked as a real .py file, not inline `-c` code —
// runSubprocess's spawn passes `args` through a shell, which would
// otherwise re-tokenize this multi-line code on its own quotes/newlines)
// — reassembled so the target script sees itself as argv[0] plus its own
// args, same as a normal `python3 script.py` invocation would give it.
const RUNNER_CODE = `
import sys, runpy, traceback

script = sys.argv[1]
sys.argv = [script] + sys.argv[2:]

try:
    runpy.run_path(script, run_name="__main__")
except (SystemExit, KeyboardInterrupt):
    raise
except BaseException:
    traceback.print_exc()
    tb = sys.exc_info()[2]
    while tb is not None and tb.tb_next is not None:
        tb = tb.tb_next
    print("\\n--- Local variables in the failing frame ---", file=sys.stderr)
    if tb is not None:
        for name, value in tb.tb_frame.f_locals.items():
            try:
                rendered = repr(value)
            except Exception as render_err:
                rendered = f"<unrepresentable: {render_err}>"
            print(f"{name} = {rendered}", file=sys.stderr)
    sys.exit(1)
`;

export function createDebugPythonTracebackTool(options: DebugPythonToolOptions = {}): ToolDefinition<DebugPythonTracebackInput> {
  const binary = options.binary ?? "python3";
  return {
    name: "debug_python_traceback",
    description:
      "Run a real Python script; if it raises an uncaught exception, capture the full traceback AND the local " +
      "variables of the frame where it actually failed (post-mortem inspection) — shows what a variable held at " +
      "the point of failure, instead of just naming the failing line the way a plain `python3 script.py` run " +
      "would. For genuinely interactive step-through debugging (breakpoints, stepping, inspecting as you go), " +
      "run `python3 -m pdb <script>` inside a tmux session instead (tmux_new_session/tmux_send_keys).",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Path to the Python script to run, relative to the project root" },
        args: { type: "array", items: { type: "string" }, description: "Arguments to pass to the script itself (as sys.argv[1:])" },
        cwd: { type: "string", description: "Working directory to run the script from, relative to the project root (defaults to the project root)" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 60000)" },
      },
      required: ["script"],
    },
    describeCall: (input) => `debug python ${input.script}${input.args?.length ? ` ${input.args.join(" ")}` : ""}`,
    async handler(input, ctx) {
      const cwd = input.cwd ? `${ctx.cwd}/${input.cwd}` : ctx.cwd;
      const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;

      const runnerDir = await mkdtemp(path.join(tmpdir(), "finanfa-debug-py-runner-"));
      try {
        const runnerPath = path.join(runnerDir, "runner.py");
        await writeFile(runnerPath, RUNNER_CODE, "utf-8");
        return await runSubprocess(binary, {
          cwd,
          sessionId: ctx.sessionId,
          timeoutMs,
          signal: ctx.signal,
          args: [runnerPath, input.script, ...(input.args ?? [])],
        });
      } finally {
        await rm(runnerDir, { recursive: true, force: true });
      }
    },
  };
}
