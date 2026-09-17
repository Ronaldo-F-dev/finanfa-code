import type { ToolDefinition } from "../../core/types.js";
import { createFleetCell, listFleetCells, stopFleetCell, removeFleetCell, createFleetNetwork, removeFleetNetwork } from "../../core/fleet.js";
import { registerFleetHost, removeFleetHost, loadFleetHosts, fleetHostLoads, pickLeastLoadedFleetHost } from "../../core/fleet-hosts.js";

interface CreateFleetCellInput {
  name: string;
  image: string;
  host_port: number;
  container_port?: number;
  workspace_dir?: string;
  memory_limit?: string;
  cpus?: string;
  restart_policy?: "no" | "on-failure" | "unless-stopped" | "always";
  health_check_command?: string[];
  network?: string;
  host?: string;
  command?: string[];
}

export const createFleetCellTool: ToolDefinition<CreateFleetCellInput> = {
  name: "create_fleet_cell",
  description:
    "Provision a new, isolated container (a \"cell\") running a given image, exposed on a host port — for " +
    "running a separate, sandboxed instance of something (another finanfa-code deployment for a different " +
    "tenant/project, or any other containerized service) alongside whatever else is running. Uses the real " +
    "`docker` CLI; every cell is named with a fixed prefix so list/stop/remove_fleet_cell can only ever affect " +
    "cells created this way, never an unrelated container. Supports real Docker resource limits " +
    "(memory_limit/cpus), a restart policy, a health check (status then shows as healthy/unhealthy in " +
    "list_fleet_cells), a shared network (see create_fleet_network) so cells can reach each other by name, and " +
    "a remote host (a real DOCKER_HOST value, e.g. \"ssh://user@remote-machine\", over the user's own already-" +
    "configured SSH) to place the cell on a different machine instead of this one. " +
    "IMPORTANT: this starts a real, network-exposed container on a real machine — confirm with the user before " +
    "calling this unless they've explicitly asked for this exact cell.",
  riskLevel: "dangerous",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Cell name — must be unique among current cells on the target host" },
      image: { type: "string", description: "Docker image to run, e.g. \"finanfa-code:latest\" or any other image" },
      host_port: { type: "number", description: "Port on the host machine to expose the cell on" },
      container_port: { type: "number", description: "Port the container itself listens on (default 4600)" },
      workspace_dir: { type: "string", description: "Absolute host path to bind-mount as the cell's /workspace, if it needs a persistent project directory" },
      memory_limit: { type: "string", description: 'Real docker --memory value, e.g. "512m", "1g"' },
      cpus: { type: "string", description: 'Real docker --cpus value, e.g. "1.5"' },
      restart_policy: { type: "string", enum: ["no", "on-failure", "unless-stopped", "always"] },
      health_check_command: { type: "array", items: { type: "string" }, description: 'Command run INSIDE the container to decide health, e.g. ["curl", "-f", "http://localhost:4600/"]' },
      network: { type: "string", description: "Joins a network created by create_fleet_network, by its short name" },
      host: {
        type: "string",
        description:
          'A real DOCKER_HOST value (e.g. "ssh://user@remote-machine") to place this cell on a specific machine. Omit to auto-schedule: if any fleet hosts are registered (see register_fleet_host), the least-loaded reachable one is picked automatically; otherwise the local Docker daemon is used, same as before this existed.',
      },
      command: { type: "array", items: { type: "string" }, description: "Overrides the image's own default command — most real cell images already have a sensible long-running entrypoint and don't need this" },
    },
    required: ["name", "image", "host_port"],
  },
  describeCall: (input) => `create fleet cell "${input.name}" (${input.image}) on port ${input.host_port}${input.host ? ` at ${input.host}` : ""}`,
  async handler(input) {
    let host = input.host;
    if (!host) {
      const registered = await loadFleetHosts();
      if (Object.keys(registered).length > 0) {
        const scheduled = await pickLeastLoadedFleetHost();
        if (!scheduled.ok) return { content: scheduled.error, isError: true };
        host = scheduled.host.dockerHost;
      }
      // No fleet hosts registered at all: host stays undefined, meaning
      // the local Docker daemon — the same behavior as before scheduling
      // existed, not a silent fallback away from a real request to use
      // the fleet.
    }

    const result = await createFleetCell({
      name: input.name,
      image: input.image,
      hostPort: input.host_port,
      containerPort: input.container_port,
      workspaceDir: input.workspace_dir,
      memoryLimit: input.memory_limit,
      cpus: input.cpus,
      restartPolicy: input.restart_policy,
      healthCheck: input.health_check_command ? { command: input.health_check_command } : undefined,
      command: input.command,
      network: input.network,
      host,
    });
    if (!result.ok) return { content: result.error, isError: true };
    return { content: `Cell "${input.name}" created (container ${result.containerId}), listening on host port ${input.host_port}${host ? ` at ${host}` : ""}.`, isError: false };
  },
};

interface DockerHostInput {
  host?: string;
}

export const listFleetCellsTool: ToolDefinition<DockerHostInput> = {
  name: "list_fleet_cells",
  description: "List every cell created by create_fleet_cell (running or stopped, with health status if one has a health check) on a given Docker daemon — never any other container. Pass host to list cells on a remote machine instead of the local one.",
  riskLevel: "safe",
  inputSchema: { type: "object", properties: { host: { type: "string", description: 'A real DOCKER_HOST value to list cells on a remote machine — omit for the local daemon' } } },
  async handler(input) {
    const cells = await listFleetCells({ host: input.host });
    if (cells.length === 0) return { content: "No fleet cells.", isError: false };
    return { content: cells.map((c) => `${c.name} (${c.containerId.slice(0, 12)}): ${c.status}${c.healthy === undefined ? "" : c.healthy ? " [healthy]" : " [UNHEALTHY]"}`).join("\n"), isError: false };
  },
};

interface FleetCellNameInput extends DockerHostInput {
  name: string;
}

export const stopFleetCellTool: ToolDefinition<FleetCellNameInput> = {
  name: "stop_fleet_cell",
  description: "Stop a running fleet cell's container (without removing it — see remove_fleet_cell for that). Pass host for a cell on a remote machine.",
  riskLevel: "ask",
  inputSchema: { type: "object", properties: { name: { type: "string" }, host: { type: "string" } }, required: ["name"] },
  describeCall: (input) => `stop fleet cell "${input.name}"${input.host ? ` at ${input.host}` : ""}`,
  async handler(input) {
    const result = await stopFleetCell(input.name, { host: input.host });
    if (!result.ok) return { content: result.error, isError: true };
    return { content: `Cell "${input.name}" stopped.`, isError: false };
  },
};

export const removeFleetCellTool: ToolDefinition<FleetCellNameInput> = {
  name: "remove_fleet_cell",
  description: "Stop (if running) and permanently remove a fleet cell's container. There's no undo — create_fleet_cell would need to provision a new one. Pass host for a cell on a remote machine.",
  riskLevel: "dangerous",
  inputSchema: { type: "object", properties: { name: { type: "string" }, host: { type: "string" } }, required: ["name"] },
  describeCall: (input) => `remove fleet cell "${input.name}"${input.host ? ` at ${input.host}` : ""}`,
  async handler(input) {
    const result = await removeFleetCell(input.name, { host: input.host });
    if (!result.ok) return { content: result.error, isError: true };
    return { content: `Cell "${input.name}" removed.`, isError: false };
  },
};

interface FleetNetworkNameInput extends DockerHostInput {
  name: string;
}

export const createFleetNetworkTool: ToolDefinition<FleetNetworkNameInput> = {
  name: "create_fleet_network",
  description: "Create a real Docker network cells can join (via create_fleet_cell's network option) to reach each other by container name. Named with a fixed prefix, same isolation property as cells themselves.",
  riskLevel: "ask",
  inputSchema: { type: "object", properties: { name: { type: "string" }, host: { type: "string" } }, required: ["name"] },
  describeCall: (input) => `create fleet network "${input.name}"${input.host ? ` at ${input.host}` : ""}`,
  async handler(input) {
    const result = await createFleetNetwork(input.name, { host: input.host });
    if (!result.ok) return { content: result.error, isError: true };
    return { content: `Network "${input.name}" created.`, isError: false };
  },
};

export const removeFleetNetworkTool: ToolDefinition<FleetNetworkNameInput> = {
  name: "remove_fleet_network",
  description: "Remove a network created by create_fleet_network (fails if a cell is still attached to it).",
  riskLevel: "dangerous",
  inputSchema: { type: "object", properties: { name: { type: "string" }, host: { type: "string" } }, required: ["name"] },
  describeCall: (input) => `remove fleet network "${input.name}"${input.host ? ` at ${input.host}` : ""}`,
  async handler(input) {
    const result = await removeFleetNetwork(input.name, { host: input.host });
    if (!result.ok) return { content: result.error, isError: true };
    return { content: `Network "${input.name}" removed.`, isError: false };
  },
};

interface RegisterFleetHostInput {
  alias: string;
  docker_host?: string;
}

export const registerFleetHostTool: ToolDefinition<RegisterFleetHostInput> = {
  name: "register_fleet_host",
  description:
    "Add a machine to the Fleet host pool that create_fleet_cell auto-schedules across when no explicit `host` " +
    "is given — a new cell then goes to whichever registered host currently has the fewest running cells. Omit " +
    "docker_host to register the local Docker daemon itself as one of the pool's hosts (useful once you also " +
    "register at least one remote one, so the local machine is still a real scheduling candidate, not silently " +
    "excluded).",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      alias: { type: "string", description: 'A short name for this host, e.g. "eu-west-1"' },
      docker_host: { type: "string", description: 'A real DOCKER_HOST value (e.g. "ssh://user@remote-machine") — omit for the local daemon' },
    },
    required: ["alias"],
  },
  describeCall: (input) => `register fleet host "${input.alias}"${input.docker_host ? ` (${input.docker_host})` : " (local daemon)"}`,
  async handler(input) {
    await registerFleetHost(input.alias, input.docker_host);
    return { content: `Registered fleet host "${input.alias}".`, isError: false };
  },
};

interface FleetHostAliasInput {
  alias: string;
}

export const removeFleetHostTool: ToolDefinition<FleetHostAliasInput> = {
  name: "remove_fleet_host",
  description: "Remove a host from the Fleet scheduling pool (see register_fleet_host). Doesn't stop or remove any cell already running there.",
  riskLevel: "ask",
  inputSchema: { type: "object", properties: { alias: { type: "string" } }, required: ["alias"] },
  describeCall: (input) => `remove fleet host "${input.alias}"`,
  async handler(input) {
    const removed = await removeFleetHost(input.alias);
    if (!removed) return { content: `No registered fleet host named "${input.alias}".`, isError: true };
    return { content: `Removed fleet host "${input.alias}".`, isError: false };
  },
};

export const listFleetHostsTool: ToolDefinition<Record<string, never>> = {
  name: "list_fleet_hosts",
  description: "List every registered Fleet host with its real, live load (a fresh docker ps/version check against each one) — which one create_fleet_cell would pick next.",
  riskLevel: "safe",
  inputSchema: { type: "object", properties: {} },
  async handler() {
    const loads = await fleetHostLoads();
    if (loads.length === 0) return { content: "No fleet hosts registered — create_fleet_cell uses the local Docker daemon.", isError: false };
    return {
      content: loads
        .map((l) => `${l.alias} (${l.dockerHost ?? "local daemon"}): ${l.reachable ? `${l.runningCells} running cell(s)` : "UNREACHABLE"}`)
        .join("\n"),
      isError: false,
    };
  },
};
