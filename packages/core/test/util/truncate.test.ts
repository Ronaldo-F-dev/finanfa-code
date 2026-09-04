import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { truncate, truncateOrSpill, spillToFile, TRUNCATE_LARGE, TRUNCATE_MEDIUM, TRUNCATE_SMALL, TRUNCATE_TINY } from "../../src/util/truncate.js";

describe("truncate", () => {
  it("returns the string unchanged when under the limit", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  it("returns the string unchanged when exactly at the limit (boundary, not just over it)", () => {
    const s = "x".repeat(10);
    expect(truncate(s, 10)).toBe(s);
  });

  it("truncates and appends a marker when over the limit", () => {
    const result = truncate("x".repeat(20), 10);
    expect(result).toBe(`${"x".repeat(10)}\n... (truncated)`);
  });

  it("the four named tiers are distinct and ordered large > medium > small > tiny", () => {
    expect(TRUNCATE_LARGE).toBeGreaterThan(TRUNCATE_MEDIUM);
    expect(TRUNCATE_MEDIUM).toBeGreaterThan(TRUNCATE_SMALL);
    expect(TRUNCATE_SMALL).toBeGreaterThan(TRUNCATE_TINY);
  });
});

describe("truncateOrSpill / spillToFile (real filesystem writes)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-spill-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the string unchanged, with no disk write, when under the limit", async () => {
    const result = await truncateOrSpill(dir, "s1", "test", "hello", 100);
    expect(result).toBe("hello");
  });

  it("spills the full text to disk and points at it when over the limit", async () => {
    const long = "x".repeat(500);
    const result = await truncateOrSpill(dir, "s1", "test", long, 100);

    expect(result).toContain("x".repeat(100));
    expect(result).toContain("truncated — full output is 500 characters, saved to");
    expect(result).not.toContain("x".repeat(101)); // preview itself isn't longer than the cap

    const relPathMatch = result.match(/saved to (\S+);/);
    expect(relPathMatch).not.toBeNull();
    const relPath = relPathMatch![1];
    const onDisk = await readFile(path.join(dir, relPath), "utf-8");
    expect(onDisk).toBe(long); // the FULL text, not just the preview
  });

  it("namespaces spilled files under the given sessionId, real directory structure", async () => {
    await truncateOrSpill(dir, "session-abc", "mytool", "y".repeat(200), 50);
    const relPath = await spillToFile(dir, "session-abc", "other", "z".repeat(10));
    expect(relPath.split(path.sep)).toEqual([".finanfa-code", "spill", "session-abc", expect.stringContaining("other")]);
  });

  it("spillToFile always writes, regardless of size, and returns the exact content back on read", async () => {
    const relPath = await spillToFile(dir, "s2", "raw", "small content");
    const onDisk = await readFile(path.join(dir, relPath), "utf-8");
    expect(onDisk).toBe("small content");
  });
});
