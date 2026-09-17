import { spawn } from "node:child_process";

// "Fleet" — multi-tenant sandboxed hosting: provisioning, listing, and
// tearing down isolated per-tenant containers, each its own real Docker
// container with its own port and (optionally) its own bind-mounted
// workspace directory. A real gap relative to a comparable project's own
// Fleet, which orchestrates many isolated cells this way. Wraps the
// user's own already-installed `docker` CLI (same "wrap the real tool,
// don't reimplement it" choice as run_docker/run_mydevops/mysql client
// tools elsewhere) rather than a Docker Engine API client library —
// every cell this module creates is named with a fixed prefix
// (CONTAINER_PREFIX) so list/stop/remove can never accidentally touch a
// container this project didn't itself create.
//
// Deliberately scoped: this manages containers on the ONE Docker daemon
// this process can already reach (local, or whatever DOCKER_HOST already
// points at) — not a multi-node/multi-host scheduler distributing cells
// across a real fleet of machines (that would need its own placement/
// scheduling logic, a genuinely bigger, separate architecture piece).
const CONTAINER_PREFIX = "finanfa-fleet-";

// Not runSubprocess (see remote-exec.ts's own comment on why): a
// container name/image/env value could contain characters a local shell
// would reinterpret if this went through shell:true+args retokenization.
function runDocker(args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; isError: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args);
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

export interface CreateFleetCellOptions {
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
}

export type FleetResult = { ok: true } | { ok: false; error: string };

export async function createFleetCell(opts: CreateFleetCellOptions): Promise<FleetResult & { containerId?: string }> {
  const args = ["run", "-d", "--name", containerName(opts.name), "-p", `${opts.hostPort}:${opts.containerPort ?? 4600}`];
  if (opts.workspaceDir) args.push("-v", `${opts.workspaceDir}:/workspace`);
  for (const [key, value] of Object.entries(opts.envVars ?? {})) args.push("-e", `${key}=${value}`);
  args.push(opts.image);
  if (opts.command) args.push(...opts.command);

  const result = await runDocker(args);
  if (result.isError) return { ok: false, error: result.stderr.trim() || "docker run failed with no output." };
  return { ok: true, containerId: result.stdout.trim() };
}

export interface FleetCellInfo {
  name: string;
  containerId: string;
  status: string;
  running: boolean;
}

/** Every cell this module has ever created that still exists (running or stopped) — never any other container on this Docker daemon, thanks to CONTAINER_PREFIX. */
export async function listFleetCells(): Promise<FleetCellInfo[]> {
  const result = await runDocker(["ps", "-a", "--filter", `name=^/${CONTAINER_PREFIX}`, "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}"]);
  if (result.isError) return [];
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [containerId, name, ...statusParts] = line.split("\t");
      const status = statusParts.join("\t");
      return { containerId: containerId ?? "", name: (name ?? "").slice(CONTAINER_PREFIX.length), status, running: status.startsWith("Up") };
    });
}

export async function stopFleetCell(name: string): Promise<FleetResult> {
  const result = await runDocker(["stop", containerName(name)]);
  if (result.isError) return { ok: false, error: result.stderr.trim() || "docker stop failed with no output." };
  return { ok: true };
}

/** Stops (if still running) and removes the cell's container entirely — there's no separate "start" for a removed cell, it must be created again. */
export async function removeFleetCell(name: string): Promise<FleetResult> {
  const result = await runDocker(["rm", "-f", containerName(name)]);
  if (result.isError) return { ok: false, error: result.stderr.trim() || "docker rm failed with no output." };
  return { ok: true };
}
