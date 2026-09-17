import { describe, expect, it, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  loadMemories,
  formatMemoryIndex,
  createReadMemoryTool,
  writeMemoryTool,
  deleteMemoryTool,
  findNearDuplicateMemory,
  findDuplicateMemoryPairs,
  findDuplicateMemoriesTool,
  createSearchMemoriesTool,
  type Memory,
} from "../../src/memory/loader.js";
import { resetMemorySearchIndexForTests } from "../../src/core/memory-search-index.js";

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

  it("write_memory records real provenance: createdAt/updatedAt and the calling session's id", async () => {
    const result = await writeMemoryTool.handler({ name: "prov", description: "d", type: "project", content: "c" }, { ...ctx(), sessionId: "session-abc" });
    expect(result.isError).toBe(false);

    const [memory] = await loadMemories(dir);
    expect(memory.createdAt).toBeTruthy();
    expect(memory.updatedAt).toBe(memory.createdAt);
    expect(memory.sourceSessionId).toBe("session-abc");
  });

  it("write_memory preserves the original createdAt/sourceSessionId across a later rewrite from a different session", async () => {
    await writeMemoryTool.handler({ name: "prov", description: "d", type: "project", content: "c" }, { ...ctx(), sessionId: "session-original" });
    const [firstWrite] = await loadMemories(dir);
    const originalCreatedAt = firstWrite.createdAt;

    await new Promise((r) => setTimeout(r, 5)); // ensure a real, distinguishable later timestamp
    await writeMemoryTool.handler({ name: "prov", description: "d", type: "project", content: "c2" }, { ...ctx(), sessionId: "session-later" });
    const [rewritten] = await loadMemories(dir);

    expect(rewritten.createdAt).toBe(originalCreatedAt); // preserved, not reset
    expect(rewritten.updatedAt).not.toBe(originalCreatedAt); // but genuinely moved forward
    expect(rewritten.sourceSessionId).toBe("session-original"); // the ORIGINAL session, not the rewriting one — real provenance means "who first created this," not "who last touched it"
  });

  it("findNearDuplicateMemory matches a similar description in the same scope, ignores a different scope or an exact-slug match", () => {
    const existing: Memory[] = [
      { name: "commit-style", description: "user prefers small atomic commits per function", type: "feedback", content: "c", scope: "project" },
      { name: "commit-style", description: "user prefers small atomic commits per function", type: "feedback", content: "c", scope: "global" },
    ];
    expect(
      findNearDuplicateMemory(existing, { name: "commit-preference", description: "user prefers atomic commits per function, small", type: "feedback", content: "c" })?.name,
    ).toBe("commit-style");
    expect(findNearDuplicateMemory(existing, { name: "commit-style", description: "user prefers small atomic commits per function", type: "feedback", content: "c" })).toBeUndefined();
    expect(findNearDuplicateMemory(existing, { name: "unrelated", description: "user is a senior typescript engineer", type: "user", content: "c" })).toBeUndefined();
  });

  it("write_memory warns when a near-duplicate note already exists (same scope, different name, similar description)", async () => {
    await writeMemoryTool.handler(
      { name: "commit-style", description: "user prefers small atomic commits per function", type: "feedback", content: "split changes" },
      ctx(),
    );
    const result = await writeMemoryTool.handler(
      { name: "commit-preference", description: "user prefers atomic commits per function, small", type: "feedback", content: "split changes again" },
      ctx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("commit-style");
    expect(result.content.toLowerCase()).toContain("similar");

    // Both are still written — this is a warning, not a block, since a
    // heuristic false positive should never silently drop a real save.
    expect(await loadMemories(dir)).toHaveLength(2);
  });

  it("write_memory does not warn about an unrelated existing memory", async () => {
    await writeMemoryTool.handler({ name: "commit-style", description: "user prefers small atomic commits", type: "feedback", content: "c" }, ctx());
    const result = await writeMemoryTool.handler({ name: "likes-typescript", description: "user is a senior TypeScript engineer", type: "user", content: "c" }, ctx());
    expect(result.content).not.toContain("similar");
  });

  it("write_memory does not warn about its own exact-slug overwrite", async () => {
    await writeMemoryTool.handler({ name: "commit-style", description: "user prefers small atomic commits", type: "feedback", content: "c" }, ctx());
    const result = await writeMemoryTool.handler({ name: "commit-style", description: "user prefers small atomic commits", type: "feedback", content: "c2" }, ctx());
    expect(result.content).not.toContain("similar");
  });

  it("findDuplicateMemoryPairs finds a near-duplicate pair within the same scope, ignoring cross-scope and self-pairs", () => {
    const memories: Memory[] = [
      { name: "commit-style", description: "user prefers small atomic commits per function", type: "feedback", content: "c", scope: "project" },
      { name: "commit-preference", description: "user prefers atomic commits per function, small", type: "feedback", content: "c", scope: "project" },
      { name: "commit-style", description: "user prefers small atomic commits per function", type: "feedback", content: "c", scope: "global" },
      { name: "unrelated", description: "user is a senior typescript engineer", type: "user", content: "c", scope: "project" },
    ];
    const pairs = findDuplicateMemoryPairs(memories);
    expect(pairs).toHaveLength(1);
    expect([pairs[0].a.name, pairs[0].b.name].sort()).toEqual(["commit-preference", "commit-style"]);
  });

  it("find_duplicate_memories tool reports likely duplicate pairs across the whole store", async () => {
    await writeMemoryTool.handler(
      { name: "commit-style", description: "user prefers small atomic commits per function", type: "feedback", content: "c" },
      ctx(),
    );
    await writeMemoryTool.handler(
      { name: "commit-preference", description: "user prefers atomic commits per function, small", type: "feedback", content: "c" },
      ctx(),
    );
    const result = await findDuplicateMemoriesTool.handler({}, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("commit-style");
    expect(result.content).toContain("commit-preference");
  });

  it("find_duplicate_memories tool reports no duplicates when there aren't any", async () => {
    await writeMemoryTool.handler({ name: "a", description: "one thing", type: "project", content: "c" }, ctx());
    const result = await findDuplicateMemoriesTool.handler({}, ctx());
    expect(result.content).toBe("No likely duplicate memories found.");
  });

  it("delete_memory tool removes a project memory by name", async () => {
    await writeMemoryTool.handler({ name: "to-delete", description: "d", type: "project", content: "c" }, ctx());
    expect(await loadMemories(dir)).toHaveLength(1);

    const result = await deleteMemoryTool.handler({ name: "to-delete" }, ctx());
    expect(result.isError).toBe(false);
    expect(await loadMemories(dir)).toHaveLength(0);
  });

  it("delete_memory tool reports a clear error for a memory that doesn't exist, instead of silently succeeding", async () => {
    const result = await deleteMemoryTool.handler({ name: "nonexistent" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No project memory named");
  });

  it("delete_memory tool respects scope: global vs project independently", async () => {
    await writeMemoryTool.handler({ name: "same-name", description: "d", type: "project", content: "c", scope: "global" }, ctx());
    // A project-scoped delete of the same name must not find/remove the global one.
    const projectResult = await deleteMemoryTool.handler({ name: "same-name" }, ctx());
    expect(projectResult.isError).toBe(true);

    const globalResult = await deleteMemoryTool.handler({ name: "same-name", scope: "global" }, ctx());
    expect(globalResult.isError).toBe(false);
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

  it("search_memories (keyword mode) finds a note by meaning-adjacent words without knowing its exact name", async () => {
    await writeMemoryTool.handler({ name: "commit-style", description: "user prefers small atomic commits", type: "feedback", content: "c" }, ctx());
    await writeMemoryTool.handler({ name: "gardening", description: "unrelated note", type: "project", content: "tomatoes" }, ctx());

    const tool = createSearchMemoriesTool(undefined);
    const result = await tool.handler({ query: "atomic commits" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("commit-style");
    expect(result.content).not.toContain("gardening");
  });

  it("search_memories reports plainly when nothing matches", async () => {
    await writeMemoryTool.handler({ name: "a", description: "d", type: "project", content: "c" }, ctx());
    const tool = createSearchMemoriesTool(undefined);
    const result = await tool.handler({ query: "completely unrelated query terms" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No saved memory matched");
  });

  it("search_memories (semantic mode) reports a clear error when not configured", async () => {
    const tool = createSearchMemoriesTool(undefined);
    const result = await tool.handler({ query: "x", mode: "semantic" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("OPENAI_API_KEY");
  });

  it("has 'safe' risk level", () => {
    expect(createSearchMemoriesTool(undefined).riskLevel).toBe("safe");
  });
});

describe("search_memories (semantic mode, real fake embeddings server, real node:sqlite)", () => {
  let dir: string;
  let homeDir: string;
  let originalHome: string | undefined;
  let server: http.Server;
  let apiBaseUrl: string;
  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  function vectorFor(text: string): [number, number] {
    if (text.includes("atomic") || text.includes("commit")) return [1, 0];
    if (text.includes("tomato")) return [0, 1];
    if (text.includes("review") || text.includes("PR")) return [0.9, 0.1];
    return [0.5, 0.5];
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as { input: string[] };
        const data = body.input.map((text, index) => ({ index, embedding: vectorFor(text) }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-search-memories-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-search-memories-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    resetMemorySearchIndexForTests();
  });

  afterEach(async () => {
    resetMemorySearchIndexForTests();
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("finds a conceptually related note with no shared keywords with the query", async () => {
    await writeMemoryTool.handler({ name: "commit-style", description: "user prefers atomic commits", type: "feedback", content: "one feature per commit" }, ctx());
    await writeMemoryTool.handler({ name: "gardening", description: "unrelated note", type: "project", content: "prune the tomato plants" }, ctx());

    const tool = createSearchMemoriesTool({ apiKey: "test" }, apiBaseUrl);
    const result = await tool.handler({ query: "how should PRs be reviewed", mode: "semantic" }, ctx());
    expect(result.isError).toBe(false);
    const commitIndex = result.content.indexOf("commit-style");
    const gardeningIndex = result.content.indexOf("gardening");
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(gardeningIndex === -1 || commitIndex < gardeningIndex).toBe(true);
  });
});
