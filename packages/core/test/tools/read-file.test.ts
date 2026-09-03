import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileTool } from "../../src/tools/builtin/read-file.js";

describe("read_file tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  it("returns content with line numbers", async () => {
    await writeFile(path.join(dir, "a.txt"), "line1\nline2");
    const result = await readFileTool.handler({ path: "a.txt" }, ctx());
    expect(result.content).toContain("1\tline1");
    expect(result.content).toContain("2\tline2");
  });

  it("respects offset and limit", async () => {
    await writeFile(path.join(dir, "a.txt"), "l1\nl2\nl3\nl4");
    const result = await readFileTool.handler({ path: "a.txt", offset: 2, limit: 2 }, ctx());
    expect(result.content).toContain("2\tl2");
    expect(result.content).toContain("3\tl3");
    expect(result.content).not.toContain("l1");
    expect(result.content).not.toContain("l4");
  });

  it("rejects paths escaping the project root", async () => {
    await expect(readFileTool.handler({ path: "../secret.txt" }, ctx())).rejects.toThrow(
      /outside the project root/,
    );
  });
});
