import { spawn } from "node:child_process";

// "Fleet" — multi-tenant sandboxed hosting: provisioning, listing, and
// tearing down isolated per-tenant containers, each its own real Docker
// container with its own port and (optionally) its own bind-mounted
// workspace directory, resource quota, health check, restart policy,
// and shared network. A real gap relative to a comparable project's own
// Fleet, which orchestrates many isolated cells this way. Wraps the
// user's own already-installed `docker` CLI (same "wrap the real tool,
// don't reimplement it" choice as run_docker/run_mydevops/mysql client
// tools elsewhere) rather than a Docker Engine API client library —
// every cell this module creates is named with a fixed prefix
// (CONTAINER_PREFIX) so list/stop/remove can never accidentally touch a
// container this project didn't itself create.
//
// Multi-host: `host` (a real Docker `DOCKER_HOST` value, e.g.
// "ssh://user@remote-machine") targets a REMOTE Docker daemon reachable
// over the user's own already-configured SSH — the real, standard way
// the `docker` CLI itself supports a remote daemon (no bespoke protocol,
// no separate agent to deploy on that machine first). This module still
// doesn't do cross-host SCHEDULING (deciding which host a cell should
// land on, load-balancing between hosts, moving one that's already
// running) — the caller picks the host explicitly, the same way you'd
// type `docker -H ssh://host ...` yourself. A real scheduler would be
// its own, genuinely larger piece on top of this.
const CONTAINER_PREFIX = "finanfa-fleet-";
const NETWORK_PREFIX = "finanfa-fleet-net-";

export interface DockerTarget {
  /** A real DOCKER_HOST value (e.g. "ssh://user@remote-host", or a tcp:// endpoint) — targets that remote daemon instead of the local one. Undefined uses whatever DOCKER_HOST is already set to in this process's own environment (typically the local daemon). */
  host?: string;
}

// Not runSubprocess (see remote-exec.ts's own comment on why): a
// container name/image/env value could contain characters a local shell
// would reinterpret if this went through shell:true+args retokenization.
function runDocker(args: string[], target: DockerTarget = {}, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; isError: boolean }> {
  return new Promise((resolve) => {
    const env = target.host ? { ...process.env, DOCKER_HOST: target.host } : process.env;
    const child = spawn("docker", args, { env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: timedOut ? `Timed out after ${timeoutMs}ms` : stderr, isError: timedOut || code !== 0 });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err.message, isError: true });
    });
  });
}

function containerName(cellName: string): string {
  return `${CONTAINER_PREFIX}${cellName}`;
}

export interface FleetHealthCheck {
  /** Run INSIDE the container to decide health — e.g. ["curl", "-f", "http://localhost:4600/"]. Real Docker HEALTHCHECK semantics: nonzero exit means unhealthy. */
  command: string[];
  intervalSeconds?: number;
  timeoutSeconds?: number;
  retries?: number;
}

export interface CreateFleetCellOptions extends DockerTarget {
  name: string;
  image: string;
  hostPort: number;
  /** Port the container itself listens on — default 4600 (this project's own default web-server port). */
  containerPort?: number;
  /** Bind-mounted to /workspace in the container, if given — the cell's own persistent project directory. */
  workspaceDir?: string;
  envVars?: Record<string, string>;
  /** Overrides the image's own default command — most real cell images (this project's own included) already have a sensible long-running entrypoint and don't need this. */
  command?: string[];
  /** Real Docker `--memory`, e.g. "512m", "1g". */
  memoryLimit?: string;
  /** Real Docker `--cpus`, e.g. "1.5". */
  cpus?: string;
  /** Real Docker `--restart` policy — "no" (default docker behavior)/"on-failure[:N]"/"unless-stopped"/"always". */
  restartPolicy?: string;
  /** Real Docker HEALTHCHECK, set per-container (overrides whatever the image's own Dockerfile defines) — status then shows up as "(healthy)"/"(unhealthy)" in listFleetCells, no extra polling needed on this module's own part. */
  healthCheck?: FleetHealthCheck;
  /** Attaches to a network created by createFleetNetwork — lets cells reach each other by container name. Same short name passed to createFleetNetwork, not the raw docker network name (the prefix is applied here too). */
  network?: string;
}

export type FleetResult = { ok: true } | { ok: false; error: string };

export async function createFleetCell(opts: CreateFleetCellOptions): Promise<FleetResult & { containerId?: string }> {
  const args = ["run", "-d", "--name", containerName(opts.name), "-p", `${opts.hostPort}:${opts.containerPort ?? 4600}`];
  if (opts.workspaceDir) args.push("-v", `${opts.workspaceDir}:/workspace`);
  for (const [key, value] of Object.entries(opts.envVars ?? {})) args.push("-e", `${key}=${value}`);
  if (opts.memoryLimit) args.push("--memory", opts.memoryLimit);
  if (opts.cpus) args.push("--cpus", opts.cpus);
  if (opts.restartPolicy) args.push("--restart", opts.restartPolicy);
  if (opts.network) args.push("--network", networkName(opts.network));
  if (opts.healthCheck) {
    args.push("--health-cmd", opts.healthCheck.command.join(" "));
    if (opts.healthCheck.intervalSeconds) args.push("--health-interval", `${opts.healthCheck.intervalSeconds}s`);
    if (opts.healthCheck.timeoutSeconds) args.push("--health-timeout", `${opts.healthCheck.timeoutSeconds}s`);
    if (opts.healthCheck.retries) args.push("--health-retries", String(opts.healthCheck.retries));
  }
  args.push(opts.image);
  if (opts.command) args.push(...opts.command);

  const result = await runDocker(args, opts);
  if (result.isError) return { ok: false, error: result.stderr.trim() || "docker run failed with no output." };
  return { ok: true, containerId: result.stdout.trim() };
}

export interface FleetCellInfo {
  name: string;
  containerId: string;
  status: string;
  running: boolean;
  /** Undefined when the cell has no HEALTHCHECK configured at all (Docker's own status string only ever mentions "(healthy)"/"(unhealthy)"/"(health: starting)" when one is) — not the same as "unknown", just "not applicable". */
  healthy?: boolean;
}

function parseHealthy(status: string): boolean | undefined {
  if (status.includes("(healthy)")) return true;
  if (status.includes("(unhealthy)")) return false;
  return undefined;
}

/** Every cell this module has ever created that still exists (running or stopped) on the given Docker daemon — never any other container, thanks to CONTAINER_PREFIX. */
export async function listFleetCells(target: DockerTarget = {}): Promise<FleetCellInfo[]> {
  const result = await runDocker(["ps", "-a", "--filter", `name=^/${CONTAINER_PREFIX}`, "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}"], target);
  if (result.isError) return [];
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [containerId, name, ...statusParts] = line.split("\t");
      const status = statusParts.join("\t");
      return { containerId: containerId ?? "", name: (name ?? "").slice(CONTAINER_PREFIX.length), status, running: status.startsWith("Up"), healthy: parseHealthy(status) };
    });
}

export async function stopFleetCell(name: string, target: DockerTarget = {}): Promise<FleetResult> {
  const result = await runDocker(["stop", containerName(name)], target);
  if (result.isError) return { ok: false, error: result.stderr.trim() || "docker stop failed with no output." };
  return { ok: true };
}

/** Stops (if still running) and removes the cell's container entirely — there's no separate "start" for a removed cell, it must be created again. */
export async function removeFleetCell(name: string, target: DockerTarget = {}): Promise<FleetResult> {
  const result = await runDocker(["rm", "-f", containerName(name)], target);
  if (result.isError) return { ok: false, error: result.stderr.trim() || "docker rm failed with no output." };
  return { ok: true };
}

function networkName(name: string): string {
  return `${NETWORK_PREFIX}${name}`;
}

/** A real Docker bridge network cells can join via createFleetCell's `network` option, so they can reach each other by container name — same fixed-prefix safety property as containers: this module can only ever affect a network it created itself. */
export async function createFleetNetwork(name: string, target: DockerTarget = {}): Promise<FleetResult> {
  const result = await runDocker(["network", "create", networkName(name)], target);
  if (result.isError) return { ok: false, error: result.stderr.trim() || "docker network create failed with no output." };
  return { ok: true };
}

export async function removeFleetNetwork(name: string, target: DockerTarget = {}): Promise<FleetResult> {
  const result = await runDocker(["network", "rm", networkName(name)], target);
  if (result.isError) return { ok: false, error: result.stderr.trim() || "docker network rm failed with no output." };
  return { ok: true };
}

/** Real network name a caller passes as createFleetCell's own `network` option — exported so a caller doesn't have to guess the prefix scheme itself. */
export function fleetNetworkNameFor(name: string): string {
  return networkName(name);
}
