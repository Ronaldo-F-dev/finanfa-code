import { describe, expect, it, afterEach, beforeAll, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFleetCell, removeFleetCell } from "../../src/core/fleet.js";
import { registerFleetHost, removeFleetHost, loadFleetHosts, fleetHostLoads, pickLeastLoadedFleetHost } from "../../src/core/fleet-hosts.js";

const execFileAsync = promisify(execFile);

describe("registerFleetHost / removeFleetHost / loadFleetHosts (real file on disk)", () => {
  let dir: string;
  let registryPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-fleet-hosts-"));
    registryPath = path.join(dir, "fleet-hosts.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("registers a host (remote or local) persisted to disk", async () => {
    await registerFleetHost("eu-west-1", "ssh://user@remote-machine", registryPath);
    await registerFleetHost("local", undefined, registryPath);
    const registry = await loadFleetHosts(registryPath);
    expect(registry["eu-west-1"]).toMatchObject({ alias: "eu-west-1", dockerHost: "ssh://user@remote-machine" });
    expect(registry["local"]?.alias).toBe("local");
    expect(registry["local"]?.dockerHost).toBeUndefined();
  });

  it("removeFleetHost removes a real host and reports whether one existed", async () => {
    await registerFleetHost("eu-west-1", "ssh://x", registryPath);
    expect(await removeFleetHost("eu-west-1", registryPath)).toBe(true);
    expect(await loadFleetHosts(registryPath)).toEqual({});
    expect(await removeFleetHost("eu-west-1", registryPath)).toBe(false);
  });

  it("loadFleetHosts returns an empty registry when nothing is registered", async () => {
    expect(await loadFleetHosts(registryPath)).toEqual({});
  });
});

describe("fleetHostLoads / pickLeastLoadedFleetHost (real docker containers)", () => {
  let dir: string;
  let registryPath: string;
  const cellNames: string[] = [];

  function uniquePort(): number {
    return 30000 + Math.floor(Math.random() * 10000);
  }

  beforeAll(async () => {
    await execFileAsync("docker", ["pull", "alpine:latest"]);
  }, 60_000);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-fleet-hosts-load-"));
    registryPath = path.join(dir, "fleet-hosts.json");
  });

  afterEach(async () => {
    while (cellNames.length > 0) {
      const name = cellNames.pop()!;
      await removeFleetCell(name).catch(() => {});
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("pickLeastLoadedFleetHost reports a clear error when no hosts are registered", async () => {
    const result = await pickLeastLoadedFleetHost(registryPath);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("No fleet hosts registered") });
  });

  it("picks the local-daemon host (undefined dockerHost is a valid pick, not treated specially) when it's the only one registered", async () => {
    await registerFleetHost("local", undefined, registryPath);
    const result = await pickLeastLoadedFleetHost(registryPath);
    expect(result).toEqual({ ok: true, host: { alias: "local", dockerHost: undefined, addedAt: expect.any(String) } });
  });

  // The real running-cell count for "the local daemon" reflects EVERY
  // fleet cell currently running on this machine's one real Docker
  // daemon — including ones sibling test files (fleet.test.ts,
  // fleet-tools.test.ts) create concurrently when the whole suite runs
  // in parallel, a real, unavoidable form of shared-resource interference
  // (unlike a port, "the one real local Docker daemon" can't be trivially
  // isolated per test file). So these assertions deliberately avoid any
  // exact/aggregate count: they only assert what's true regardless of
  // what else is running concurrently — that OUR OWN cell (once created)
  // is always counted, i.e. runningCells is at least 1 (never fewer,
  // since sibling files can't remove a container this test created).
  it("fleetHostLoads reports the real running-cell count for a real registered host", async () => {
    await registerFleetHost("local", undefined, registryPath);

    const name = `fleethost-test-${Date.now()}`;
    cellNames.push(name);
    await createFleetCell({ name, image: "alpine:latest", hostPort: uniquePort(), command: ["sleep", "60"] });

    const loads = await fleetHostLoads(registryPath);
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({ alias: "local", dockerHost: undefined, reachable: true });
    expect(loads[0]!.runningCells).toBeGreaterThanOrEqual(1);
  });

  it("pickLeastLoadedFleetHost breaks a tie between two hosts pointed at the same daemon alphabetically", async () => {
    // Both entries target the SAME real local Docker daemon (no second
    // real machine available here) but are tracked as two independent
    // "hosts" in the registry. Polled together they always report an
    // identical count as each other (same daemon, same instant) — no
    // container needs to be created for this, so there's nothing here
    // for a sibling test file's containers to race against.
    await registerFleetHost("quiet", undefined, registryPath);
    await registerFleetHost("busy", undefined, registryPath);

    const loads = await fleetHostLoads(registryPath);
    expect(loads.every((l) => l.reachable)).toBe(true);
    expect(loads[0]!.runningCells).toBe(loads[1]!.runningCells);

    const result = await pickLeastLoadedFleetHost(registryPath);
    expect(result).toEqual({ ok: true, host: { alias: "busy", dockerHost: undefined, addedAt: expect.any(String) } }); // alphabetically first among an exact tie
  });

  it("excludes an unreachable host from scheduling instead of treating it as idle", async () => {
    await registerFleetHost("unreachable", "tcp://127.0.0.1:1", registryPath); // nothing real listening there
    await registerFleetHost("local", undefined, registryPath);

    const loads = await fleetHostLoads(registryPath);
    expect(loads.find((l) => l.alias === "unreachable")).toMatchObject({ reachable: false });

    const result = await pickLeastLoadedFleetHost(registryPath);
    expect(result).toEqual({ ok: true, host: { alias: "local", dockerHost: undefined, addedAt: expect.any(String) } });
  }, 20_000);

  it("pickLeastLoadedFleetHost reports a clear error when every registered host is unreachable", async () => {
    await registerFleetHost("unreachable", "tcp://127.0.0.1:1", registryPath);
    const result = await pickLeastLoadedFleetHost(registryPath);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("currently reachable") });
  }, 15_000);
});
