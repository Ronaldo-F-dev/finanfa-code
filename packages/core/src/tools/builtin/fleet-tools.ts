import type { ToolDefinition } from "../../core/types.js";
import { createFleetCell, listFleetCells, stopFleetCell, removeFleetCell, createFleetNetwork, removeFleetNetwork } from "../../core/fleet.js";

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
      host: { type: "string", description: 'A real DOCKER_HOST value (e.g. "ssh://user@remote-machine") to place this cell on a different machine — omit to use the local Docker daemon' },
    },
    required: ["name", "image", "host_port"],
  },
  describeCall: (input) => `create fleet cell "${input.name}" (${input.image}) on port ${input.host_port}${input.host ? ` at ${input.host}` : ""}`,
  async handler(input) {
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
      network: input.network,
      host: input.host,
    });
    if (!result.ok) return { content: result.error, isError: true };
    return { content: `Cell "${input.name}" created (container ${result.containerId}), listening on host port ${input.host_port}.`, isError: false };
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
