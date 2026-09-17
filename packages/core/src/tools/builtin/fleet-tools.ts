import type { ToolDefinition } from "../../core/types.js";
import { createFleetCell, listFleetCells, stopFleetCell, removeFleetCell } from "../../core/fleet.js";

interface CreateFleetCellInput {
  name: string;
  image: string;
  host_port: number;
  container_port?: number;
  workspace_dir?: string;
}

export const createFleetCellTool: ToolDefinition<CreateFleetCellInput> = {
  name: "create_fleet_cell",
  description:
    "Provision a new, isolated container (a \"cell\") running a given image, exposed on a host port — for " +
    "running a separate, sandboxed instance of something (another finanfa-code deployment for a different " +
    "tenant/project, or any other containerized service) alongside whatever else is running. Uses the real " +
    "`docker` CLI; every cell is named with a fixed prefix so list/stop/remove_fleet_cell can only ever affect " +
    "cells created this way, never an unrelated container. " +
    "IMPORTANT: this starts a real, network-exposed container on the user's real machine — confirm with the " +
    "user before calling this unless they've explicitly asked for this exact cell.",
  riskLevel: "dangerous",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Cell name — must be unique among current cells" },
      image: { type: "string", description: "Docker image to run, e.g. \"finanfa-code:latest\" or any other image" },
      host_port: { type: "number", description: "Port on the host machine to expose the cell on" },
      container_port: { type: "number", description: "Port the container itself listens on (default 4600)" },
      workspace_dir: { type: "string", description: "Absolute host path to bind-mount as the cell's /workspace, if it needs a persistent project directory" },
    },
    required: ["name", "image", "host_port"],
  },
  describeCall: (input) => `create fleet cell "${input.name}" (${input.image}) on port ${input.host_port}`,
  async handler(input) {
    const result = await createFleetCell({ name: input.name, image: input.image, hostPort: input.host_port, containerPort: input.container_port, workspaceDir: input.workspace_dir });
    if (!result.ok) return { content: result.error, isError: true };
    return { content: `Cell "${input.name}" created (container ${result.containerId}), listening on host port ${input.host_port}.`, isError: false };
  },
};

export const listFleetCellsTool: ToolDefinition<Record<string, never>> = {
  name: "list_fleet_cells",
  description: "List every cell created by create_fleet_cell (running or stopped) — never any other container on this Docker daemon.",
  riskLevel: "safe",
  inputSchema: { type: "object", properties: {} },
  async handler() {
    const cells = await listFleetCells();
    if (cells.length === 0) return { content: "No fleet cells.", isError: false };
    return { content: cells.map((c) => `${c.name} (${c.containerId.slice(0, 12)}): ${c.status}`).join("\n"), isError: false };
  },
};

interface FleetCellNameInput {
  name: string;
}

export const stopFleetCellTool: ToolDefinition<FleetCellNameInput> = {
  name: "stop_fleet_cell",
  description: "Stop a running fleet cell's container (without removing it — see remove_fleet_cell for that).",
  riskLevel: "ask",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  describeCall: (input) => `stop fleet cell "${input.name}"`,
  async handler(input) {
    const result = await stopFleetCell(input.name);
    if (!result.ok) return { content: result.error, isError: true };
    return { content: `Cell "${input.name}" stopped.`, isError: false };
  },
};

export const removeFleetCellTool: ToolDefinition<FleetCellNameInput> = {
  name: "remove_fleet_cell",
  description: "Stop (if running) and permanently remove a fleet cell's container. There's no undo — create_fleet_cell would need to provision a new one.",
  riskLevel: "dangerous",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  describeCall: (input) => `remove fleet cell "${input.name}"`,
  async handler(input) {
    const result = await removeFleetCell(input.name);
    if (!result.ok) return { content: result.error, isError: true };
    return { content: `Cell "${input.name}" removed.`, isError: false };
  },
};
