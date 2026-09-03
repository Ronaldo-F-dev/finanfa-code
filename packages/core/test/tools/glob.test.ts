import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { globTool } from "../../src/tools/builtin/glob.js";

describe("glob tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-glob-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("matches files by glob pattern, sorted", async () => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "b.ts"), "");
    await writeFile(path.join(dir, "src", "a.ts"), "");
    await writeFile(path.join(dir, "readme.md"), "");

    const result = await globTool.handler({ pattern: "src/**/*.ts" }, ctx());
    expect(result.content).toBe("src/a.ts\nsrc/b.ts");
    expect(result.metadata).toEqual({ count: 2 });
  });

  it("returns '(no matches)' when nothing matches", async () => {
    const result = await globTool.handler({ pattern: "*.nonexistent" }, ctx());
    expect(result.content).toBe("(no matches)");
    expect(result.metadata).toEqual({ count: 0 });
  });

  it("truncates output past 1000 matches, but metadata.count reflects the true total", async () => {
    await mkdir(path.join(dir, "many"), { recursive: true });
    await Promise.all(
      Array.from({ length: 1005 }, (_, i) => writeFile(path.join(dir, "many", `f${i}.txt`), "")),
    );

    const result = await globTool.handler({ pattern: "many/*.txt" }, ctx());

    expect(result.metadata).toEqual({ count: 1005 });
    expect(result.content).toContain("... (truncated, showing first 1000 of 1005 matches)");
    expect(result.content.split("\n").filter((l) => l.startsWith("many/"))).toHaveLength(1000);
  });
});
