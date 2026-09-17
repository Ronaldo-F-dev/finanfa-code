import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runSsh, buildSshArgs } from "../tools/builtin/remote-exec.js";

// A real known-hosts registry for node-host — the "node" half of remote
// execution that run_remote_command's own one-off SSH calls didn't have
// on their own: a persistent, named list of remote machines with their
// last-known reachability, so the agent (or the user) can ask "which of
// my remote nodes are actually up right now?" instead of re-typing
// host/user/port for every single command. Deliberately still not a
// deployed agent process on each remote node (that would need installing
// and running software there first, out of reach for a tool that only
// ever connects out over the user's own already-configured SSH) — health
// here means "can I reach it and run a command right now," checked live
// each time, not a persistent heartbeat this module receives.
export interface RemoteHostEntry {
  alias: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  addedAt: string;
  lastCheckedAt?: string;
  lastHealthy?: boolean;
  lastHealthSummary?: string;
}

export function defaultRemoteHostsPath(): string {
  return path.join(os.homedir(), ".finanfa-code", "remote-hosts.json");
}

export type RemoteHostRegistry = Record<string, RemoteHostEntry>;

export async function loadRemoteHosts(filePath: string = defaultRemoteHostsPath()): Promise<RemoteHostRegistry> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as RemoteHostRegistry;
  } catch {
    return {};
  }
}

async function saveRemoteHosts(filePath: string, registry: RemoteHostRegistry): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(registry, null, 2), "utf-8");
  await rename(tmp, filePath);
}

export interface RegisterRemoteHostInput {
  alias: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/** Adds a new host, or updates an existing alias's connection details (health/lastChecked fields are left untouched by an update — re-registering doesn't erase health history). */
export async function registerRemoteHost(input: RegisterRemoteHostInput, filePath: string = defaultRemoteHostsPath()): Promise<void> {
  const registry = await loadRemoteHosts(filePath);
  const existing = registry[input.alias];
  registry[input.alias] = {
    alias: input.alias,
    host: input.host,
    user: input.user,
    port: input.port,
    identityFile: input.identityFile,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    lastCheckedAt: existing?.lastCheckedAt,
    lastHealthy: existing?.lastHealthy,
    lastHealthSummary: existing?.lastHealthSummary,
  };
  await saveRemoteHosts(filePath, registry);
}

export async function removeRemoteHost(alias: string, filePath: string = defaultRemoteHostsPath()): Promise<boolean> {
  const registry = await loadRemoteHosts(filePath);
  if (!(alias in registry)) return false;
  delete registry[alias];
  await saveRemoteHosts(filePath, registry);
  return true;
}

const HEALTH_CHECK_COMMAND = "uptime && echo ---FLEET-HEALTH-DISK--- && df -h / 2>/dev/null || df -Pk /";
const HEALTH_CHECK_TIMEOUT_MS = 15_000;

export interface HealthCheckResult {
  healthy: boolean;
  summary: string;
}

/** Runs a real, portable, read-only health probe (uptime + disk usage) over SSH — reuses run_remote_command's own argv-building (buildSshArgs) and subprocess runner (runSsh), so this is exactly the same real SSH invocation shape, not a second implementation that could drift from it. */
export async function checkRemoteHostHealth(entry: RemoteHostEntry, binary = "ssh"): Promise<HealthCheckResult> {
  const args = buildSshArgs({ host: entry.host, command: HEALTH_CHECK_COMMAND, user: entry.user, port: entry.port, identityFile: entry.identityFile });
  const result = await runSsh(binary, args, HEALTH_CHECK_TIMEOUT_MS);
  if (result.isError) return { healthy: false, summary: result.stderr.trim() || "unreachable" };
  return { healthy: true, summary: result.stdout.trim() };
}

/** Runs checkRemoteHostHealth and persists the outcome onto the registered entry, so list_remote_hosts can show a "last known" status without re-checking every host on every listing. */
export async function checkAndRecordRemoteHostHealth(alias: string, filePath: string = defaultRemoteHostsPath(), binary = "ssh"): Promise<HealthCheckResult | undefined> {
  const registry = await loadRemoteHosts(filePath);
  const entry = registry[alias];
  if (!entry) return undefined;
  const result = await checkRemoteHostHealth(entry, binary);
  registry[alias] = { ...entry, lastCheckedAt: new Date().toISOString(), lastHealthy: result.healthy, lastHealthSummary: result.summary };
  await saveRemoteHosts(filePath, registry);
  return result;
}
