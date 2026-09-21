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

export type LocalModelStatus =
  | { state: "already-running-correct"; modelId: string }
  | { state: "already-running-different-model"; runningModelId: string; expected: string }
  | { state: "started"; modelId: string }
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

function pidFilePath(modelName: string): string {
  const safe = modelName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(os.homedir(), ".finanfa-code", "local-models", `${safe}.pid`);
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
 * same port.
 */
export async function ensureLocalTextModelServer(opts: EnsureLocalTextModelOptions): Promise<LocalModelStatus> {
  const binary = opts.binary ?? DEFAULT_BINARY;
  const contextSize = opts.contextSize ?? DEFAULT_CONTEXT_SIZE;
  const startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  const runningModelId = await checkRunningModel(opts.baseUrl);
  if (runningModelId) {
    return namesLooselyMatch(runningModelId, opts.modelName)
      ? { state: "already-running-correct", modelId: runningModelId }
      : { state: "already-running-different-model", runningModelId, expected: opts.modelName };
  }

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
    const pidFile = pidFilePath(opts.modelName);
    await mkdir(path.dirname(pidFile), { recursive: true });
    await writeFile(pidFile, String(child.pid), "utf-8");
  }

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const modelId = await checkRunningModel(opts.baseUrl);
    if (modelId) return { state: "started", modelId };
  }
  return { state: "start-failed", message: `timed out after ${startupTimeoutMs}ms waiting for ${binary} to start serving ${opts.modelPath}` };
}

/** Stops a server this module itself started (tracked via its pidfile) — a no-op, not an error, if none is tracked or it's already gone. Never touches a process it didn't spawn. */
export async function stopManagedLocalModel(modelName: string): Promise<boolean> {
  const pidFile = pidFilePath(modelName);
  let pid: number;
  try {
    pid = Number((await readFile(pidFile, "utf-8")).trim());
  } catch {
    return false;
  }
  if (!Number.isFinite(pid)) {
    await rm(pidFile, { force: true });
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already dead — fine, just clean up the stale pidfile below.
  }
  await rm(pidFile, { force: true });
  return true;
}
