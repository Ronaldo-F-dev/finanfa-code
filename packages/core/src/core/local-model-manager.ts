import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

const DEFAULT_BINARY = "llama-server";
const DEFAULT_CONTEXT_SIZE = 8192;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 2000;
const STOP_WAIT_MS = 3000;

export type LocalModelStatus =
  | { state: "already-running-correct"; modelId: string }
  | { state: "already-running-different-model"; runningModelId: string; expected: string }
  | { state: "started"; modelId: string }
  | { state: "restarted"; modelId: string; previousModelId: string }
  | { state: "missing-binary"; binary: string }
  | { state: "missing-model-file"; path: string }
  | { state: "start-failed"; message: string };

export interface EnsureLocalTextModelOptions {
  /** The OpenAI-compatible base URL to reach it at, e.g. "http://127.0.0.1:8080/v1". */
  baseUrl: string;
  /** Absolute path to the .gguf file to load if nothing is already serving it. */
  modelPath: string;
  /** Expected model id/name — compared (case-insensitively, substring either way) against whatever a running server actually reports, since llama-server may report a bare filename, a stem, or a full path depending on how it was launched. */
  modelName: string;
  binary?: string;
  contextSize?: number;
  startupTimeoutMs?: number;
  /**
   * When the port is already serving a *different* model: false (the
   * default — right for an app/CLI startup check, where a mismatch is
   * unexpected and touching a stranger's process would be a surprise) just
   * reports the mismatch. true (right for a deliberate model switch — the
   * user picked a different local model on purpose) stops whatever's there
   * first, but *only* if this same module is the one that started it
   * (tracked by port — see wasStartedByUs); a server this module didn't
   * spawn itself is never touched either way.
   */
  restartIfDifferent?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function binaryIsAvailable(binary: string): Promise<boolean> {
  try {
    // llama-server (and every stand-in used in tests) prints its version
    // and exits immediately for --version — never starts serving, so this
    // is a safe, fast check rather than an accidental real launch.
    await execFileAsync(binary, ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function namesLooselyMatch(a: string, b: string): boolean {
  const na = a.toLowerCase();
  const nb = b.toLowerCase();
  return na.includes(nb) || nb.includes(na);
}

/** Queries an OpenAI-compatible /models endpoint — same shape core/local-providers.ts's own probe() already relies on. Resolves to undefined for "nothing answering there", never throws. */
export async function checkRunningModel(baseUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: { id: string }[] };
    return body.data?.[0]?.id;
  } catch {
    return undefined;
  }
}

interface PidRecord {
  modelName: string;
  pid: number;
}

// Keyed by port, not model name: the thing actually being contended for is
// the port, and a deliberate model switch needs to answer "did *we* start
// whatever's currently on this port" regardless of which model that was —
// a model-name-keyed file couldn't answer that without already knowing
// which name to look up.
function pidFilePath(port: string): string {
  const safe = port.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(os.homedir(), ".finanfa-code", "local-models", `port-${safe}.pid`);
}

async function readPidRecord(port: string): Promise<PidRecord | undefined> {
  try {
    return JSON.parse(await readFile(pidFilePath(port), "utf-8")) as PidRecord;
  } catch {
    return undefined;
  }
}

function portFromBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.port || "80";
}

/** True if this module itself started whatever's currently listening on this baseUrl's port (tracked via its pidfile) — the one thing that must be true before restartIfDifferent is allowed to stop it. */
export async function wasStartedByUs(baseUrl: string): Promise<PidRecord | undefined> {
  return readPidRecord(portFromBaseUrl(baseUrl));
}

async function stopPort(port: string): Promise<boolean> {
  const record = await readPidRecord(port);
  if (!record) return false;
  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    // Already dead — fine, just clean up the stale pidfile below.
  }
  await rm(pidFilePath(port), { force: true });
  return true;
}

/** Stops a server this module itself started (tracked via its pidfile, keyed by the port it's listening on) — a no-op, not an error, if none is tracked or it's already gone. Never touches a process it didn't spawn. */
export async function stopManagedLocalModel(baseUrl: string): Promise<boolean> {
  return stopPort(portFromBaseUrl(baseUrl));
}

async function spawnAndWait(
  opts: EnsureLocalTextModelOptions,
  binary: string,
  contextSize: number,
  startupTimeoutMs: number,
): Promise<LocalModelStatus> {
  if (!(await binaryIsAvailable(binary))) {
    return { state: "missing-binary", binary };
  }
  if (!(await fileExists(opts.modelPath))) {
    return { state: "missing-model-file", path: opts.modelPath };
  }

  const url = new URL(opts.baseUrl);
  const host = url.hostname;
  const port = url.port || "80";

  const child = spawn(
    binary,
    ["-m", opts.modelPath, "--host", host, "--port", port, "-c", String(contextSize)],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  if (typeof child.pid === "number") {
    const pidFile = pidFilePath(port);
    await mkdir(path.dirname(pidFile), { recursive: true });
    await writeFile(pidFile, JSON.stringify({ modelName: opts.modelName, pid: child.pid } satisfies PidRecord), "utf-8");
  }

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const modelId = await checkRunningModel(opts.baseUrl);
    if (modelId) return { state: "started", modelId };
  }
  return { state: "start-failed", message: `timed out after ${startupTimeoutMs}ms waiting for ${binary} to start serving ${opts.modelPath}` };
}

/**
 * Real, reported friction: getting llama.cpp serving the default local text
 * model running at all was the hard part for the user, not configuring
 * finanfa-code to talk to it once it was up. This closes that gap: check
 * what (if anything) is already answering at baseUrl, and if it's not the
 * expected model, try to start it — rather than assuming the user already
 * has the right server running and just failing unhelpfully if not.
 *
 * Never touches a server it didn't start itself: if something else is
 * already answering with a different model, this reports that (so the
 * caller can tell the user) instead of killing an unrelated process on the
 * same port — unless restartIfDifferent is set AND this module is the one
 * that started what's currently there (a deliberate model switch).
 */
export async function ensureLocalTextModelServer(opts: EnsureLocalTextModelOptions): Promise<LocalModelStatus> {
  const binary = opts.binary ?? DEFAULT_BINARY;
  const contextSize = opts.contextSize ?? DEFAULT_CONTEXT_SIZE;
  const startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const port = portFromBaseUrl(opts.baseUrl);

  const runningModelId = await checkRunningModel(opts.baseUrl);
  if (runningModelId) {
    if (namesLooselyMatch(runningModelId, opts.modelName)) {
      return { state: "already-running-correct", modelId: runningModelId };
    }
    if (!opts.restartIfDifferent || !(await wasStartedByUs(opts.baseUrl))) {
      return { state: "already-running-different-model", runningModelId, expected: opts.modelName };
    }
    await stopPort(port);
    // Give the OS a moment to actually free the port before rebinding it —
    // llama-server's own shutdown isn't instant.
    const stopDeadline = Date.now() + STOP_WAIT_MS;
    while ((await checkRunningModel(opts.baseUrl)) && Date.now() < stopDeadline) {
      await sleep(200);
    }
    const result = await spawnAndWait(opts, binary, contextSize, startupTimeoutMs);
    return result.state === "started" ? { state: "restarted", modelId: result.modelId, previousModelId: runningModelId } : result;
  }

  return spawnAndWait(opts, binary, contextSize, startupTimeoutMs);
}
