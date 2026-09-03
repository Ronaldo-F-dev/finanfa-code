import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool } from "../../src/memory/loader.js";

describe("memory loader", () => {
  let dir: string;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-memory-"));
    // loadMemories also reads the *real* ~/.finanfa-code/memory unless $HOME
    // is overridden — without this, these tests would start failing the
    // moment any real global memory exists on the machine running them.
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-memory-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("returns an empty list when there is no memory directory", async () => {
    expect(await loadMemories(dir)).toEqual([]);
  });

  it("merges global (~/.finanfa-code/memory) and project-local memories", async () => {
    await mkdir(path.join(homeDir, ".finanfa-code", "memory"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".finanfa-code", "memory", "global-note.md"),
      "---\nname: global-note\ndescription: applies everywhere\nmetadata:\n  type: user\n---\n\nglobal content",
    );
    await mkdir(path.join(dir, ".finanfa-code", "memory"), { recursive: true });
    await writeFile(
      path.join(dir, ".finanfa-code", "memory", "project-note.md"),
      "---\nname: project-note\ndescription: this repo only\nmetadata:\n  type: project\n---\n\nproject content",
    );

    const memories = await loadMemories(dir);
    const names = memories.map((m) => m.name).sort();
    expect(names).toEqual(["global-note", "project-note"]);
  });

  it("project-local memory wins over a global one with the same name", async () => {
    await mkdir(path.join(homeDir, ".finanfa-code", "memory"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".finanfa-code", "memory", "note.md"),
      "---\nname: note\ndescription: global version\nmetadata:\n  type: user\n---\n\nglobal",
    );
    await mkdir(path.join(dir, ".finanfa-code", "memory"), { recursive: true });
    await writeFile(
      path.join(dir, ".finanfa-code", "memory", "note.md"),
      "---\nname: note\ndescription: project version\nmetadata:\n  type: project\n---\n\nproject",
    );

    const memories = await loadMemories(dir);
    expect(memories).toHaveLength(1);
    expect(memories[0].description).toBe("project version");
  });

  it("write_memory scope: global writes to ~/.finanfa-code/memory instead of the project", async () => {
    const result = await writeMemoryTool.handler(
      { name: "always-use-mydevops", description: "systemwide preference", type: "user", content: "c", scope: "global" },
      ctx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("global");

    const globalFile = await readFile(path.join(homeDir, ".finanfa-code", "memory", "always-use-mydevops.md"), "utf-8");
    expect(globalFile).toContain("always-use-mydevops");

    const memories = await loadMemories(dir);
    expect(memories.map((m) => m.name)).toContain("always-use-mydevops");
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

  it("warns (but doesn't throw) on a memory file with malformed YAML frontmatter, and still loads the other files", async () => {
    const memDir = path.join(dir, ".finanfa-code", "memory");
    await mkdir(memDir, { recursive: true });
    // Unbalanced flow-collection bracket — gray-matter's YAML parser throws
    // a YAMLException on this, which used to propagate out of loadMemories
    // and crash the whole CLI at startup.
    await writeFile(
      path.join(memDir, "corrupt.md"),
      "---\nname: [unclosed\ndescription: broken\n---\n\nbody",
    );
    await writeFile(
      path.join(memDir, "good-note.md"),
      "---\nname: good-note\ndescription: fine\nmetadata:\n  type: project\n---\n\ngood content",
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const memories = await loadMemories(dir);
      expect(memories.map((m) => m.name)).toEqual(["good-note"]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain("corrupt.md");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("builds a short index string for the system prompt", () => {
    const index = formatMemoryIndex([{ name: "m", description: "desc", type: "project", content: "...", scope: "project" }]);
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
