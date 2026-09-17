import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { listFleetCells, pingDockerHost } from "./fleet.js";

// A real Fleet host pool + automatic placement — the actual "scheduler"
// half of Fleet that createFleetCell's own `host` option didn't have on
// its own (the caller had to pick a host explicitly every time). Still
// deliberately modest: placement is "which registered host currently has
// the fewest running cells," checked live via a real `docker ps` on each
// host at schedule time — not bin-packing by actual CPU/memory
// availability, not live-migrating an already-running cell off an
// overloaded host, and not a persistent scheduling daemon of its own.
// That's a real, honest boundary: those would need genuinely more
// infrastructure (continuous resource telemetry, a cell being relocatable
// at all) than "ask each host how busy it is right now and pick the
// quietest one" needs.
export interface FleetHostEntry {
  alias: string;
  /** A real DOCKER_HOST value (e.g. "ssh://user@remote-machine") — undefined means the local Docker daemon this process can already reach. */
  dockerHost?: string;
  addedAt: string;
}

export function defaultFleetHostsPath(): string {
  return path.join(os.homedir(), ".finanfa-code", "fleet-hosts.json");
}

export type FleetHostRegistry = Record<string, FleetHostEntry>;

export async function loadFleetHosts(filePath: string = defaultFleetHostsPath()): Promise<FleetHostRegistry> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as FleetHostRegistry;
  } catch {
    return {};
  }
}

async function saveFleetHosts(filePath: string, registry: FleetHostRegistry): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(registry, null, 2), "utf-8");
  await rename(tmp, filePath);
}

export async function registerFleetHost(alias: string, dockerHost: string | undefined, filePath: string = defaultFleetHostsPath()): Promise<void> {
  const registry = await loadFleetHosts(filePath);
  registry[alias] = { alias, dockerHost, addedAt: registry[alias]?.addedAt ?? new Date().toISOString() };
  await saveFleetHosts(filePath, registry);
}

export async function removeFleetHost(alias: string, filePath: string = defaultFleetHostsPath()): Promise<boolean> {
  const registry = await loadFleetHosts(filePath);
  if (!(alias in registry)) return false;
  delete registry[alias];
  await saveFleetHosts(filePath, registry);
  return true;
}

export interface FleetHostLoad {
  alias: string;
  dockerHost?: string;
  runningCells: number;
  /** False when this host's own `docker ps` call itself failed (unreachable daemon) — excluded from scheduling, not just "0 cells." */
  reachable: boolean;
}

/** Real, live load per registered host (a real `docker version` + `docker ps` against each one) — what pickLeastLoadedHost bases its decision on, also useful on its own (see list_fleet_hosts). */
export async function fleetHostLoads(filePath: string = defaultFleetHostsPath()): Promise<FleetHostLoad[]> {
  const registry = await loadFleetHosts(filePath);
  return Promise.all(
    Object.values(registry).map(async (entry) => {
      const reachable = await pingDockerHost({ host: entry.dockerHost });
      if (!reachable) return { alias: entry.alias, dockerHost: entry.dockerHost, runningCells: 0, reachable: false };
      const cells = await listFleetCells({ host: entry.dockerHost });
      return { alias: entry.alias, dockerHost: entry.dockerHost, runningCells: cells.filter((c) => c.running).length, reachable: true };
    }),
  );
}

export type ScheduleResult = { ok: true; host: FleetHostEntry } | { ok: false; error: string };

/** Picks the reachable registered host with the fewest currently-running cells (ties broken by alias, for a deterministic result) — undefined dockerHost (the local daemon) is a perfectly valid pick, not treated specially. */
export async function pickLeastLoadedFleetHost(filePath: string = defaultFleetHostsPath()): Promise<ScheduleResult> {
  const registry = await loadFleetHosts(filePath);
  const entries = Object.values(registry);
  if (entries.length === 0) return { ok: false, error: "No fleet hosts registered — see register_fleet_host, or pass `host` explicitly." };

  const loads = await fleetHostLoads(filePath);
  const reachable = loads.filter((l) => l.reachable);
  if (reachable.length === 0) return { ok: false, error: "No registered fleet host is currently reachable." };

  reachable.sort((a, b) => a.runningCells - b.runningCells || a.alias.localeCompare(b.alias));
  const chosen = reachable[0]!;
  return { ok: true, host: registry[chosen.alias]! };
}
