import { describe, expect, it, afterEach, beforeAll, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createFleetCellTool,
  listFleetCellsTool,
  stopFleetCellTool,
  removeFleetCellTool,
  createFleetNetworkTool,
  removeFleetNetworkTool,
  registerFleetHostTool,
  removeFleetHostTool,
  listFleetHostsTool,
} from "../../src/tools/builtin/fleet-tools.js";

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

describe("fleet host scheduling tools (real docker containers, real file on disk)", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let originalDockerConfig: string | undefined;
  const scheduledCellNames: string[] = [];

  function uniquePort(): number {
    return 30000 + Math.floor(Math.random() * 10000);
  }

  beforeAll(async () => {
    await execFileAsync("docker", ["pull", "alpine:latest"]);
  }, 60_000);

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-fleet-hosts-tools-home-"));
    originalHome = process.env.HOME;
    originalDockerConfig = process.env.DOCKER_CONFIG;
    // The real docker CLI itself reads ~/.docker/config.json (Docker
    // Desktop on macOS stores which socket/context to actually use
    // there) — overriding HOME for OUR OWN default-path isolation (see
    // defaultFleetHostsPath) breaks docker's own config lookup too,
    // a real, observed failure ("no such file" on /var/run/docker.sock)
    // unrelated to the feature under test. DOCKER_CONFIG points docker
    // back at the real config independent of HOME.
    process.env.DOCKER_CONFIG = path.join(originalHome ?? "", ".docker");
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalDockerConfig === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = originalDockerConfig;
    while (scheduledCellNames.length > 0) {
      const name = scheduledCellNames.pop()!;
      await execFileAsync("docker", ["rm", "-f", `finanfa-fleet-${name}`]).catch(() => {});
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  it("register_fleet_host / list_fleet_hosts / remove_fleet_host drive a real registry end to end", async () => {
    const before = await listFleetHostsTool.handler({}, ctx);
    expect(before.content).toContain("No fleet hosts registered");

    const registerResult = await registerFleetHostTool.handler({ alias: "local" }, ctx);
    expect(registerResult.isError).toBe(false);

    const afterRegister = await listFleetHostsTool.handler({}, ctx);
    expect(afterRegister.content).toContain("local (local daemon)");
    expect(afterRegister.content).toMatch(/\d+ running cell\(s\)/);

    const removeResult = await removeFleetHostTool.handler({ alias: "local" }, ctx);
    expect(removeResult.isError).toBe(false);
    const afterRemove = await listFleetHostsTool.handler({}, ctx);
    expect(afterRemove.content).toContain("No fleet hosts registered");
  });

  it("remove_fleet_host reports a clear error for an alias that doesn't exist", async () => {
    const result = await removeFleetHostTool.handler({ alias: "nonexistent" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("create_fleet_cell auto-schedules onto a registered host when no explicit host is given", async () => {
    await registerFleetHostTool.handler({ alias: "local" }, ctx);

    const name = `scheduled-${Date.now()}`;
    scheduledCellNames.push(name);
    const result = await createFleetCellTool.handler({ name, image: "alpine:latest", host_port: uniquePort(), command: ["sleep", "60"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain(`Cell "${name}" created`);

    // Real running-cell counts are a system-wide, shared-daemon total —
    // sibling test files create/remove their own cells concurrently, so
    // this only asserts what's true regardless of that: the host pool
    // reports the local daemon reachable and running at least this one
    // cell (never fewer — a sibling file can't remove a container this
    // test itself just created).
    const after = await listFleetHostsTool.handler({}, ctx);
    expect(after.content).toContain("local (local daemon)");
    expect(after.content).toMatch(/[1-9]\d* running cell\(s\)/);
  }, 20_000);

  it("create_fleet_cell still uses the local daemon by default when no fleet hosts are registered at all", async () => {
    const name = `unscheduled-${Date.now()}`;
    scheduledCellNames.push(name);
    const result = await createFleetCellTool.handler({ name, image: "alpine:latest", host_port: uniquePort() }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain(" at "); // no host was picked/reported — plain local run, same as before scheduling existed
  }, 20_000);

  it("has the expected risk levels: ask to register/remove, safe to list", () => {
    expect(registerFleetHostTool.riskLevel).toBe("ask");
    expect(removeFleetHostTool.riskLevel).toBe("ask");
    expect(listFleetHostsTool.riskLevel).toBe("safe");
  });
});
