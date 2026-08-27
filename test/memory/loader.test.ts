import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool } from "../../src/memory/loader.js";

describe("memory loader", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-memory-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("returns an empty list when there is no memory directory", async () => {
    expect(await loadMemories(dir)).toEqual([]);
  });

  it("parses frontmatter (including nested metadata.type) and body from memory files", async () => {
    await mkdir(path.join(dir, ".finanfa-code", "memory"), { recursive: true });
    await writeFile(
      path.join(dir, ".finanfa-code", "memory", "prefers-atomic-commits.md"),
      '---\nname: prefers-atomic-commits\ndescription: "One feature per commit"\nmetadata:\n  type: feedback\n---\n\nAlways split unrelated changes into separate commits.',
    );

    const memories = await loadMemories(dir);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      name: "prefers-atomic-commits",
      description: "One feature per commit",
      type: "feedback",
      content: "Always split unrelated changes into separate commits.",
    });
  });

  it("builds a short index string for the system prompt", () => {
    const index = formatMemoryIndex([{ name: "m", description: "desc", type: "project", content: "..." }]);
    expect(index).toContain("m (project): desc");
    expect(formatMemoryIndex([])).toBe("");
  });

  it("write_memory persists a note that loadMemories then finds", async () => {
    const result = await writeMemoryTool.handler(
      { name: "Prefers Atomic Commits!", description: "one feature per commit", type: "feedback", content: "split changes" },
      ctx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("prefers-atomic-commits");

    const memories = await loadMemories(dir);
    expect(memories).toHaveLength(1);
    expect(memories[0].name).toBe("prefers-atomic-commits");
    expect(memories[0].type).toBe("feedback");
  });

  it("write_memory slugifies the name and rejects an empty slug", async () => {
    const bad = await writeMemoryTool.handler({ name: "!!!", description: "d", type: "project", content: "c" }, ctx());
    expect(bad.isError).toBe(true);
  });

  it("write_memory escapes a description containing a colon/quotes so YAML stays valid", async () => {
    await writeMemoryTool.handler(
      { name: "tricky", description: 'a "quoted": value', type: "reference", content: "c" },
      ctx(),
    );
    const raw = await readFile(path.join(dir, ".finanfa-code", "memory", "tricky.md"), "utf-8");
    const memories = await loadMemories(dir);
    expect(raw).toContain("description:");
    expect(memories[0].description).toBe('a "quoted": value');
  });

  it("read_memory tool re-reads from disk, seeing a memory written after tool creation", async () => {
    const tool = createReadMemoryTool(dir);
    const missing = await tool.handler({ name: "later" }, ctx());
    expect(missing.isError).toBe(true);

    await writeMemoryTool.handler({ name: "later", description: "d", type: "project", content: "full content" }, ctx());
    const found = await tool.handler({ name: "later" }, ctx());
    expect(found.isError).toBe(false);
    expect(found.content).toBe("full content");
  });
});
