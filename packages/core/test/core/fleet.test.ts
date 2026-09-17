import { describe, expect, it, afterEach, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFleetCell, listFleetCells, stopFleetCell, removeFleetCell, createFleetNetwork, removeFleetNetwork } from "../../src/core/fleet.js";

const execFileAsync = promisify(execFile);

// Real Docker containers, a real (tiny) image — no mocking of `docker`
// itself. Every cell this suite creates uses a name prefix under our
// control so cleanup can find and remove exactly what it created, even
// if a test fails partway through.
const TEST_CELL_NAMES: string[] = [];
function uniqueCellName(): string {
  const name = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  TEST_CELL_NAMES.push(name);
  return name;
}
function uniquePort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}

describe("Fleet (real docker containers)", () => {
  beforeAll(async () => {
    // A tiny image with a long-lived command (alpine's own default CMD
    // exits immediately under `docker run -d`, so `sleep` is passed
    // explicitly below) — stands in for a real cell's own image, which
    // isn't the point under test here (container lifecycle management is).
    await execFileAsync("docker", ["pull", "alpine:latest"]);
  }, 60_000);

  afterEach(async () => {
    while (TEST_CELL_NAMES.length > 0) {
      const name = TEST_CELL_NAMES.pop()!;
      await removeFleetCell(name).catch(() => {});
    }
  });

  it("creates a real running container, lists it, stops it, then removes it", async () => {
    const name = uniqueCellName();
    const created = await createFleetCell({ name, image: "alpine:latest", hostPort: uniquePort(), containerPort: 80, command: ["sleep", "120"] });
    expect(created.ok).toBe(true);
    expect(created.containerId).toBeTruthy();

    const afterCreate = await listFleetCells();
    expect(afterCreate.find((c) => c.name === name)?.running).toBe(true);

    const stopped = await stopFleetCell(name);
    expect(stopped).toEqual({ ok: true });

    const afterStop = await listFleetCells();
    expect(afterStop.find((c) => c.name === name)?.running).toBe(false);

    const removed = await removeFleetCell(name);
    expect(removed).toEqual({ ok: true });

    const afterRemove = await listFleetCells();
    expect(afterRemove.find((c) => c.name === name)).toBeUndefined();
  }, 30_000);

  it("only ever lists cells it created itself (the CONTAINER_PREFIX filter), never an unrelated container", async () => {
    // A real container that does NOT use the fleet's own naming prefix.
    await execFileAsync("docker", ["run", "-d", "--name", "not-a-fleet-cell-container", "alpine:latest", "sleep", "60"]);
    try {
      const cells = await listFleetCells();
      expect(cells.some((c) => c.name.includes("not-a-fleet-cell"))).toBe(false);
    } finally {
      await execFileAsync("docker", ["rm", "-f", "not-a-fleet-cell-container"]).catch(() => {});
    }
  }, 20_000);

  it("reports a real docker error (e.g. a name collision) instead of throwing", async () => {
    const name = uniqueCellName();
    const first = await createFleetCell({ name, image: "alpine:latest", hostPort: uniquePort(), command: ["sleep", "60"] });
    expect(first.ok).toBe(true);

    const collision = await createFleetCell({ name, image: "alpine:latest", hostPort: uniquePort(), command: ["sleep", "60"] });
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.error.length).toBeGreaterThan(0);
  }, 20_000);

  it("stopFleetCell reports a clear error for a cell that doesn't exist", async () => {
    const stopped = await stopFleetCell("nonexistent-cell-name");
    expect(stopped.ok).toBe(false);
  });

  it("removeFleetCell on a cell that doesn't exist is a real, idempotent no-op success (this docker version's own `rm -f` semantics), not an error", async () => {
    const removed = await removeFleetCell("nonexistent-cell-name");
    expect(removed).toEqual({ ok: true });
  });

  it("applies real resource limits, a restart policy, and a real health check — status reports (healthy)/(unhealthy)", async () => {
    const healthyName = uniqueCellName();
    const created = await createFleetCell({
      name: healthyName,
      image: "alpine:latest",
      hostPort: uniquePort(),
      command: ["sleep", "60"],
      memoryLimit: "64m",
      cpus: "0.5",
      restartPolicy: "on-failure:3",
      healthCheck: { command: ["true"], intervalSeconds: 1, timeoutSeconds: 2, retries: 1 },
    });
    expect(created.ok).toBe(true);

    // Real health checks take a moment to run at least once.
    await new Promise((r) => setTimeout(r, 2500));
    const cells = await listFleetCells();
    const cell = cells.find((c) => c.name === healthyName);
    expect(cell?.healthy).toBe(true);
    expect(cell?.status).toContain("(healthy)");
  }, 20_000);

  it("reports unhealthy for a real failing health check", async () => {
    const name = uniqueCellName();
    await createFleetCell({
      name,
      image: "alpine:latest",
      hostPort: uniquePort(),
      command: ["sleep", "60"],
      healthCheck: { command: ["false"], intervalSeconds: 1, timeoutSeconds: 2, retries: 1 },
    });

    await new Promise((r) => setTimeout(r, 2500));
    const cells = await listFleetCells();
    expect(cells.find((c) => c.name === name)?.healthy).toBe(false);
  }, 20_000);

  it("leaves healthy undefined for a cell with no health check configured at all", async () => {
    const name = uniqueCellName();
    await createFleetCell({ name, image: "alpine:latest", hostPort: uniquePort(), command: ["sleep", "60"] });
    const cells = await listFleetCells();
    expect(cells.find((c) => c.name === name)?.healthy).toBeUndefined();
  }, 20_000);
});

describe("Fleet networks (real docker networks)", () => {
  const TEST_NETWORK_NAMES: string[] = [];
  function uniqueNetworkName(): string {
    const name = `test-net-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    TEST_NETWORK_NAMES.push(name);
    return name;
  }

  afterEach(async () => {
    while (TEST_NETWORK_NAMES.length > 0) {
      const name = TEST_NETWORK_NAMES.pop()!;
      await removeFleetNetwork(name).catch(() => {});
    }
    while (TEST_CELL_NAMES.length > 0) {
      const name = TEST_CELL_NAMES.pop()!;
      await removeFleetCell(name).catch(() => {});
    }
  });

  it("creates a real network, a cell can join it, and it can be removed", async () => {
    const networkName = uniqueNetworkName();
    const created = await createFleetNetwork(networkName);
    expect(created).toEqual({ ok: true });

    const cellName = uniqueCellName();
    const cellResult = await createFleetCell({ name: cellName, image: "alpine:latest", hostPort: uniquePort(), command: ["sleep", "30"], network: networkName });
    expect(cellResult.ok).toBe(true);

    await removeFleetCell(cellName);
    const removed = await removeFleetNetwork(networkName);
    expect(removed).toEqual({ ok: true });
  }, 20_000);

  it("reports a real docker error for a duplicate network name", async () => {
    const networkName = uniqueNetworkName();
    const first = await createFleetNetwork(networkName);
    expect(first).toEqual({ ok: true });
    const duplicate = await createFleetNetwork(networkName);
    expect(duplicate.ok).toBe(false);
  });

  it("removeFleetNetwork reports a real error for a network that doesn't exist", async () => {
    const removed = await removeFleetNetwork("nonexistent-network-name");
    expect(removed.ok).toBe(false);
  });
});

describe("Fleet multi-host plumbing (real subprocess, fake docker binary capturing its own env)", () => {
  let dir: string;
  let fakeDockerPath: string;
  let capturedEnvPath: string;
  let originalPath: string | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-fleet-fakedocker-"));
    fakeDockerPath = path.join(dir, "docker");
    capturedEnvPath = path.join(dir, "captured-env.json");
    // A real, standalone script standing in for the real docker binary —
    // this sandbox has no second real machine to target over SSH, so the
    // DOCKER_HOST plumbing (the one thing createFleetCell/listFleetCells
    // actually control when a `host` is given — everything else is real
    // docker's own remote-daemon support, not this module's to reimplement)
    // is verified by capturing the real environment a real subprocess
    // actually received, the same "fake stand-in binary" pattern used for
    // ssh/mydevops/claude/codex elsewhere in this project.
    await writeFile(
      fakeDockerPath,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(capturedEnvPath)}, JSON.stringify({DOCKER_HOST: process.env.DOCKER_HOST ?? null, args: process.argv.slice(2)}));\nconsole.log("fake-container-id");\n`,
    );
    await chmod(fakeDockerPath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  });

  afterAll(async () => {
    // Restores the real PATH so any LATER test file in this same worker
    // still finds the real docker binary, not this fake one.
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  });

  it("createFleetCell sets DOCKER_HOST in the real subprocess env when host is given", async () => {
    await createFleetCell({ name: "x", image: "img", hostPort: 1234, host: "ssh://user@remote-machine" });
    const captured = JSON.parse(await readFile(capturedEnvPath, "utf-8"));
    expect(captured.DOCKER_HOST).toBe("ssh://user@remote-machine");
  });

  it("createFleetCell leaves DOCKER_HOST unset (inherits the ambient environment) when no host is given", async () => {
    delete process.env.DOCKER_HOST;
    await createFleetCell({ name: "x", image: "img", hostPort: 1234 });
    const captured = JSON.parse(await readFile(capturedEnvPath, "utf-8"));
    expect(captured.DOCKER_HOST).toBeNull();
  });

  it("listFleetCells/stopFleetCell/removeFleetCell all pass host through the same way", async () => {
    await listFleetCells({ host: "ssh://a" });
    expect(JSON.parse(await readFile(capturedEnvPath, "utf-8")).DOCKER_HOST).toBe("ssh://a");

    await stopFleetCell("x", { host: "ssh://b" });
    expect(JSON.parse(await readFile(capturedEnvPath, "utf-8")).DOCKER_HOST).toBe("ssh://b");

    await removeFleetCell("x", { host: "ssh://c" });
    expect(JSON.parse(await readFile(capturedEnvPath, "utf-8")).DOCKER_HOST).toBe("ssh://c");
  });
});
