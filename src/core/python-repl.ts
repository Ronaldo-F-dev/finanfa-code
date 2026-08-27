import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

export interface PythonReplResult {
  stdout: string;
  stderr: string;
  result: string | null;
  error: string | null;
  timedOut?: boolean;
}

const MAX_OUTPUT = 50_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n... (truncated)` : s;
}

// Reads one JSON object per line from stdin (namespace persists across
// lines), and writes exactly one JSON object per line back to stdout —
// json.dumps() never emits a literal newline inside the encoded string
// (embedded "\n"s are escaped), so each response is reliably exactly one
// readline "line" event on the Node side, with no separate framing/sentinel
// needed.
//
// Catches BaseException, not just Exception — code calling sys.exit() would
// otherwise kill this whole process via an uncaught SystemExit, ending the
// REPL session (verified against a real `sys.exit()` call while designing
// this: it silently terminated the driver process, breaking every later
// command in the same session for no good reason — a REPL should survive
// that the same way a real Python/IPython shell does).
const DRIVER_SCRIPT = `
import sys, json, ast, io, contextlib, traceback

namespace = {}

def run(code):
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    result_repr = None
    error = None
    try:
        with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
            tree = ast.parse(code, "<repl>", "exec")
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                last = tree.body.pop()
                if tree.body:
                    exec(compile(tree, "<repl>", "exec"), namespace)
                result = eval(compile(ast.Expression(last.value), "<repl>", "eval"), namespace)
                if result is not None:
                    result_repr = repr(result)
                    namespace["_"] = result
            else:
                exec(compile(tree, "<repl>", "exec"), namespace)
    except BaseException:
        error = traceback.format_exc()
    return {"stdout": stdout_buf.getvalue(), "stderr": stderr_buf.getvalue(), "result": result_repr, "error": error}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    print(json.dumps(run(request["code"])), flush=True)
`;

/**
 * A persistent Python process per session, so variables/imports/function
 * defs survive across separate python_repl tool calls the way they would in
 * a real interactive session — the actual value a REPL adds over just
 * shelling out to `python3 -c`, where every call starts from nothing.
 */
export class PythonReplManager {
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pendingLines: string[] = [];

  private ensureStarted(): ChildProcess {
    if (this.child) return this.child;
    const child = spawn("python3", ["-u", "-c", DRIVER_SCRIPT]);
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this.pendingLines.push(line));
    child.on("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.rl = null;
      }
    });
    child.unref();
    this.child = child;
    this.rl = rl;
    return child;
  }

  reset(): void {
    if (this.child) {
      this.child.kill("SIGKILL");
      this.child = null;
      this.rl = null;
    }
    this.pendingLines = [];
  }

  async run(code: string, timeoutMs: number): Promise<PythonReplResult> {
    const child = this.ensureStarted();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // The process is presumed stuck (e.g. an infinite loop) — killing it
        // is the only way to make the session usable again; the next call
        // transparently spawns a fresh one (state from before the timeout
        // is lost, same as if a real REPL you were driving had to be killed
        // and restarted).
        this.reset();
        resolve({ stdout: "", stderr: "", result: null, error: null, timedOut: true });
      }, timeoutMs);

      // Self-removing: consumes exactly one line, then unregisters — without
      // this, every run() call would leave its listener attached forever,
      // and a later line would trigger every past (already-resolved) call's
      // handler too, each trying to shift from the same queue.
      const checkForLine = () => {
        if (this.pendingLines.length === 0) return;
        this.rl?.off("line", checkForLine);
        clearTimeout(timer);
        const line = this.pendingLines.shift() as string;
        try {
          const parsed = JSON.parse(line) as PythonReplResult;
          resolve({
            stdout: truncate(parsed.stdout),
            stderr: truncate(parsed.stderr),
            result: parsed.result ? truncate(parsed.result) : parsed.result,
            error: parsed.error ? truncate(parsed.error) : parsed.error,
          });
        } catch {
          resolve({ stdout: "", stderr: "", result: null, error: `Malformed REPL response: ${line}` });
        }
      };

      this.rl?.on("line", checkForLine);
      if (this.pendingLines.length > 0) checkForLine();
      child.stdin?.write(`${JSON.stringify({ code })}\n`);
    });
  }
}
