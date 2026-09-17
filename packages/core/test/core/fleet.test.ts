import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createFleetCell, listFleetCells, stopFleetCell, removeFleetCell } from "../../src/core/fleet.js";

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
});
