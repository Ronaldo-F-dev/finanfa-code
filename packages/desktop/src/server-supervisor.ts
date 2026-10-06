import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseReadyPort, type ServerSpawn } from "./server-launch.js";

export interface RunningServer {
  port: number;
  /** Everything the server has printed so far (kept bounded) — shown when it dies unexpectedly. */
  output: () => string;
  /** Stops the server and everything it started. Safe to call twice. */
  stop: () => Promise<void>;
  /** Resolves with the exit code if the server ends on its own (a crash), never if we stopped it. */
  crashed: Promise<number | null>;
}

const MAX_OUTPUT_CHARS = 20_000;
const START_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 3_000;

/** Kills the server's whole process group (it spawns children: tool subprocesses, a browser), not just the process we started. */
function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Starts the server and resolves once it has printed its "listening" line (or rejects on a crash/timeout, with the output in the message). */
export function startServer(spec: ServerSpawn, cwd: string, startTimeoutMs = START_TIMEOUT_MS): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    // detached: its own process group, so killTree can reach every descendant.
    const child = spawn(spec.command, spec.args, { cwd, env: spec.env, detached: process.platform !== "win32" });
    let output = "";
    let ready = false;
    let stopping = false;
    let settleCrash!: (code: number | null) => void;
    const crashed = new Promise<number | null>((r) => (settleCrash = r));

    const timer = setTimeout(() => {
      killTree(child, "SIGKILL");
      reject(new Error(`The server did not start within ${startTimeoutMs / 1000}s.\n${output}`));
    }, startTimeoutMs);

    const onData = (d: Buffer) => {
      output = (output + d.toString()).slice(-MAX_OUTPUT_CHARS);
      if (ready) return;
      const port = parseReadyPort(output);
      if (port === undefined) return;
      ready = true;
      clearTimeout(timer);
      resolve({
        port,
        output: () => output,
        crashed,
        stop: async () => {
          if (stopping) return;
          stopping = true;
          const exited = new Promise<void>((r) => child.once("exit", () => r()));
          killTree(child, "SIGTERM");
          const forced = setTimeout(() => killTree(child, "SIGKILL"), STOP_GRACE_MS);
          await exited;
          clearTimeout(forced);
        },
      });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the server: ${err.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!ready) reject(new Error(`The server exited before it was ready (code ${code}).\n${output}`));
      else if (!stopping) settleCrash(code);
    });
  });
}
