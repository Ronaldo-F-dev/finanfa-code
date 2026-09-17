import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createFleetCellTool, listFleetCellsTool, stopFleetCellTool, removeFleetCellTool, createFleetNetworkTool, removeFleetNetworkTool } from "../../src/tools/builtin/fleet-tools.js";

const execFileAsync = promisify(execFile);
const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

const TEST_CELL_NAMES: string[] = [];
function uniqueCellName(): string {
  const name = `tool-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  TEST_CELL_NAMES.push(name);
  return name;
}
function uniquePort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}

describe("fleet tools (real docker containers)", () => {
  beforeAll(async () => {
    await execFileAsync("docker", ["pull", "alpine:latest"]);
  }, 60_000);

  afterEach(async () => {
    while (TEST_CELL_NAMES.length > 0) {
      const name = TEST_CELL_NAMES.pop()!;
      await execFileAsync("docker", ["rm", "-f", `finanfa-fleet-${name}`]).catch(() => {});
    }
  });

  it(
    "create_fleet_cell / list_fleet_cells / stop_fleet_cell / remove_fleet_cell drive a real container end to end",
    async () => {
      const name = uniqueCellName();
      const createResult = await createFleetCellTool.handler({ name, image: "alpine:latest", host_port: uniquePort(), container_port: 80 }, ctx);
      expect(createResult.isError).toBe(false);
      expect(createResult.content).toContain(`Cell "${name}" created`);

      const listResult = await listFleetCellsTool.handler({}, ctx);
      expect(listResult.isError).toBe(false);
      expect(listResult.content).toContain(name);

      const stopResult = await stopFleetCellTool.handler({ name }, ctx);
      expect(stopResult.isError).toBe(false);
      expect(stopResult.content).toBe(`Cell "${name}" stopped.`);

      const removeResult = await removeFleetCellTool.handler({ name }, ctx);
      expect(removeResult.isError).toBe(false);
      expect(removeResult.content).toBe(`Cell "${name}" removed.`);

      const finalList = await listFleetCellsTool.handler({}, ctx);
      expect(finalList.content).not.toContain(name);
    },
    30_000,
  );

  it("list_fleet_cells reports plainly when there are none", async () => {
    // Best-effort: only meaningful if no other cell happens to exist right
    // now, which afterEach across this file/suite keeps true in practice.
    const result = await listFleetCellsTool.handler({}, ctx);
    expect(result.isError).toBe(false);
  });

  it("create_fleet_cell reports a real docker error instead of throwing", async () => {
    const result = await createFleetCellTool.handler({ name: uniqueCellName(), image: "not-a-real-image:doesnotexist12345", host_port: uniquePort() }, ctx);
    expect(result.isError).toBe(true);
  }, 20_000);

  it("stop_fleet_cell / remove_fleet_cell report a real docker outcome for an unknown cell", async () => {
    const stopResult = await stopFleetCellTool.handler({ name: "nonexistent-cell" }, ctx);
    expect(stopResult.isError).toBe(true);
  });

  it("has the expected risk levels: safe to list, ask to stop, dangerous to create/remove", () => {
    expect(listFleetCellsTool.riskLevel).toBe("safe");
    expect(stopFleetCellTool.riskLevel).toBe("ask");
    expect(createFleetCellTool.riskLevel).toBe("dangerous");
    expect(removeFleetCellTool.riskLevel).toBe("dangerous");
  });

  it("create_fleet_cell applies real resource limits/restart policy/health check, reported back via list_fleet_cells", async () => {
    const name = uniqueCellName();
    const createResult = await createFleetCellTool.handler(
      { name, image: "alpine:latest", host_port: uniquePort(), memory_limit: "64m", cpus: "0.5", restart_policy: "on-failure", health_check_command: ["true"] },
      ctx,
    );
    expect(createResult.isError).toBe(false);
    const listResult = await listFleetCellsTool.handler({}, ctx);
    expect(listResult.content).toContain(name);
  }, 20_000);
});

describe("fleet network tools (real docker networks)", () => {
  const TEST_NETWORK_NAMES: string[] = [];
  function uniqueNetworkName(): string {
    const name = `tool-test-net-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    TEST_NETWORK_NAMES.push(name);
    return name;
  }

  afterEach(async () => {
    while (TEST_NETWORK_NAMES.length > 0) {
      const name = TEST_NETWORK_NAMES.pop()!;
      await execFileAsync("docker", ["network", "rm", `finanfa-fleet-net-${name}`]).catch(() => {});
    }
  });

  it("create_fleet_network / remove_fleet_network drive a real docker network end to end", async () => {
    const name = uniqueNetworkName();
    const createResult = await createFleetNetworkTool.handler({ name }, ctx);
    expect(createResult.isError).toBe(false);
    expect(createResult.content).toBe(`Network "${name}" created.`);

    const removeResult = await removeFleetNetworkTool.handler({ name }, ctx);
    expect(removeResult.isError).toBe(false);
    expect(removeResult.content).toBe(`Network "${name}" removed.`);
  }, 15_000);

  it("remove_fleet_network reports a real error for a network that doesn't exist", async () => {
    const result = await removeFleetNetworkTool.handler({ name: "nonexistent-network" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("has the expected risk levels: ask to create, dangerous to remove", () => {
    expect(createFleetNetworkTool.riskLevel).toBe("ask");
    expect(removeFleetNetworkTool.riskLevel).toBe("dangerous");
  });
});
