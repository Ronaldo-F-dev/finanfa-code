import { spawn, type ChildProcess } from "node:child_process";

const POLL_INTERVAL_MS = 250;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 2000;

export interface LocalServiceConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  healthUrl?: string;
  readyTimeoutMs?: number;
  idleStopMs?: number;
}

export type LocalServiceStatus =
  | { state: "already-running" }
  | { state: "started" }
  | { state: "start-failed"; message: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Queries an OpenAI-compatible /models endpoint. Resolves to true for "something's answering there", never throws. */
async function probeHealth(healthUrl: string): Promise<boolean> {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Queries an OpenAI-compatible /models endpoint and returns the first model id reported there, if any — same probe as probeHealth, kept for callers that want the id rather than a bare boolean. Resolves to undefined for "nothing answering there", never throws. */
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

interface ManagedEntry {
  child: ChildProcess;
  refCount: number;
  idleTimer?: NodeJS.Timeout;
}

// In-memory only, keyed by a stable string identifying the exact launch —
// no pidfile on disk. Concurrent callers for the same key share one
// in-flight startup promise instead of racing to spawn twice, and this
// module only ever stops a process it finds in this map, never anything
// merely answering healthUrl that it didn't itself spawn.
const managed = new Map<string, ManagedEntry>();
const starting = new Map<string, Promise<LocalServiceStatus>>();

function serviceKey(service: LocalServiceConfig, healthUrl: string): string {
  return JSON.stringify({
    command: service.command,
    args: service.args ?? [],
    cwd: service.cwd ?? null,
    env: service.env ?? null,
    healthUrl,
  });
}

function healthUrlFor(baseUrl: string, service: LocalServiceConfig): string {
  return service.healthUrl ?? `${baseUrl.replace(/\/$/, "")}/models`;
}

function clearIdleTimer(entry: ManagedEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
}

function stopEntry(key: string, entry: ManagedEntry): void {
  clearIdleTimer(entry);
  managed.delete(key);
  try {
    entry.child.kill("SIGTERM");
  } catch {
    // Already dead — fine.
  }
}

async function startService(key: string, service: LocalServiceConfig, healthUrl: string): Promise<LocalServiceStatus> {
  const child = spawn(service.command, service.args ?? [], {
    cwd: service.cwd,
    env: service.env ? { ...process.env, ...service.env } : undefined,
    stdio: "ignore",
  });
  managed.set(key, { child, refCount: 0 });
  // A command that can't be started (not installed, not executable) is reported on the "error" event — an
  // EventEmitter with no listener for it throws, which used to take the whole host process (e.g. the web
  // server) down at startup just because a configured local model runtime was missing.
  let spawnError: Error | undefined;
  child.once("error", (err) => {
    spawnError = err;
    if (managed.get(key)?.child === child) managed.delete(key);
  });
  child.once("exit", () => {
    const entry = managed.get(key);
    if (entry?.child === child) managed.delete(key);
  });

  const readyTimeoutMs = service.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth(healthUrl)) return { state: "started" };
    if (spawnError) return { state: "start-failed", message: `could not start ${service.command}: ${spawnError.message}` };
    await sleep(POLL_INTERVAL_MS);
  }
  if (spawnError) return { state: "start-failed", message: `could not start ${service.command}: ${spawnError.message}` };
  const entry = managed.get(key);
  if (entry) stopEntry(key, entry);
  return { state: "start-failed", message: `timed out after ${readyTimeoutMs}ms waiting for ${service.command} to answer ${healthUrl}` };
}

async function ensureLocalServiceInner(key: string, service: LocalServiceConfig, healthUrl: string): Promise<LocalServiceStatus> {
  if (managed.get(key)) return { state: "already-running" };
  if (await probeHealth(healthUrl)) return { state: "already-running" };
  return startService(key, service, healthUrl);
}

/**
 * Generic, runtime-agnostic local-service supervisor — replaces the old
 * llama.cpp/MLX-specific manager. The user supplies the exact command/args
 * to launch whatever they've configured at baseUrl; this module never
 * guesses a runtime's invocation shape, checks for a model file on disk, or
 * suggests a download — it just probes, and if nothing answers, spawns.
 *
 * Deliberately not `async`: the starting-map check-and-register below must
 * happen with no await in between, so two calls made back to back (e.g.
 * inside Promise.all) are guaranteed to see and share the same in-flight
 * promise rather than racing each other into a double spawn.
 */
export function ensureLocalService(
  config: { baseUrl: string; healthUrl?: string },
  service: LocalServiceConfig,
): Promise<LocalServiceStatus> {
  const healthUrl = config.healthUrl ?? healthUrlFor(config.baseUrl, service);
  const key = serviceKey(service, healthUrl);

  const inFlight = starting.get(key);
  if (inFlight) return inFlight;

  const promise = ensureLocalServiceInner(key, service, healthUrl).finally(() => starting.delete(key));
  starting.set(key, promise);
  return promise;
}

/** Stops a service this module itself started (tracked in the in-memory map above) — a harmless no-op if none is tracked for this exact command/args/healthUrl. Never touches a process it didn't spawn. */
export async function stopLocalService(config: { baseUrl: string; healthUrl?: string }, service: LocalServiceConfig): Promise<boolean> {
  const healthUrl = config.healthUrl ?? healthUrlFor(config.baseUrl, service);
  const key = serviceKey(service, healthUrl);
  const entry = managed.get(key);
  if (!entry) return false;
  stopEntry(key, entry);
  return true;
}

/**
 * Runs fn while this service is held "active" — if service.idleStopMs is
 * set, the spawned process (if this module is the one that started it) is
 * stopped that many ms after the last active caller releases it; if unset,
 * it's never auto-stopped, matching the "no idle-stop by default" behavior.
 */
export async function withLocalService<T>(
  config: { baseUrl: string; healthUrl?: string },
  service: LocalServiceConfig,
  fn: () => Promise<T>,
): Promise<T> {
  const healthUrl = config.healthUrl ?? healthUrlFor(config.baseUrl, service);
  const key = serviceKey(service, healthUrl);
  await ensureLocalService(config, service);

  const entry = managed.get(key);
  if (entry) {
    clearIdleTimer(entry);
    entry.refCount += 1;
  }
  try {
    return await fn();
  } finally {
    const current = managed.get(key);
    if (current) {
      current.refCount = Math.max(0, current.refCount - 1);
      if (current.refCount === 0 && service.idleStopMs && service.idleStopMs > 0) {
        current.idleTimer = setTimeout(() => {
          const latest = managed.get(key);
          if (latest && latest.refCount === 0) stopEntry(key, latest);
        }, service.idleStopMs);
      }
    }
  }
}
