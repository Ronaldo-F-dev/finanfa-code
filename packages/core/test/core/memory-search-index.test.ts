import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { searchMemoriesBySimilarity, searchMemoriesByKeyword, ensureMemoriesEmbedded, resetMemorySearchIndexForTests } from "../../src/core/memory-search-index.js";
import type { Memory } from "../../src/memory/loader.js";

function memory(name: string, description: string, content: string): Memory {
  return { name, description, type: "project", content, scope: "project" };
}

describe("searchMemoriesByKeyword (no API, no persistence)", () => {
  it("ranks a note matching more query terms above one matching fewer", () => {
    const memories = [
      memory("a", "user prefers atomic commits", "one feature per commit"),
      memory("b", "user prefers atomic small commits always", "split changes into small pieces"),
    ];
    const hits = searchMemoriesByKeyword(memories, "atomic small commits", 5);
    expect(hits[0]?.memory.name).toBe("b");
    expect(hits[1]?.memory.name).toBe("a");
  });

  it("matches on content even when the description doesn't mention the term", () => {
    const memories = [memory("a", "a short label", "the user is a senior TypeScript engineer")];
    const hits = searchMemoriesByKeyword(memories, "typescript", 5);
    expect(hits).toHaveLength(1);
  });

  it("returns nothing for a query with no matching terms at all", () => {
    const memories = [memory("a", "atomic commits", "content")];
    expect(searchMemoriesByKeyword(memories, "gardening tomatoes", 5)).toEqual([]);
  });
});

describe("searchMemoriesBySimilarity (real fake embeddings server, real node:sqlite)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let embedRequestCount: number;
  let homeDir: string;
  let originalHome: string | undefined;

  // Same deterministic-vector-by-content-match convention as
  // session-search-index-semantic.test.ts — a real embeddings model's
  // actual vectors aren't reproducible enough to assert an exact ranking
  // against.
  function vectorFor(text: string): [number, number] {
    if (text.includes("atomic") || text.includes("commit")) return [1, 0];
    if (text.includes("garden") || text.includes("tomato")) return [0, 1];
    if (text.includes("PR") || text.includes("review")) return [0.9, 0.1]; // close to the commit-style vector, no shared keywords
    return [0.5, 0.5];
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        embedRequestCount++;
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
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-memory-search-index-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    resetMemorySearchIndexForTests();
    embedRequestCount = 0;
  });

  afterEach(async () => {
    resetMemorySearchIndexForTests();
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("finds a semantically related memory with no shared keywords with the query", async () => {
    const memories = [
      memory("commit-style", "user prefers atomic commits", "one feature per commit"),
      memory("garden", "unrelated note", "prune the tomato plants in spring"),
    ];
    const hits = await searchMemoriesBySimilarity(memories, "how should PRs be reviewed", 5, { apiKey: "test" }, apiBaseUrl);
    expect(hits[0]?.memory.name).toBe("commit-style");
    expect(hits.at(-1)?.memory.name).toBe("garden");
  });

  it("caches embeddings by content — a second call embeds nothing new", async () => {
    const memories = [memory("a", "user prefers atomic commits", "content")];
    await ensureMemoriesEmbedded(memories, { apiKey: "test" }, apiBaseUrl);
    const afterFirst = embedRequestCount;
    expect(afterFirst).toBeGreaterThan(0);

    await ensureMemoriesEmbedded(memories, { apiKey: "test" }, apiBaseUrl);
    expect(embedRequestCount).toBe(afterFirst); // nothing new to embed
  });

  it("re-embeds a memory whose content actually changed, but not the others", async () => {
    const memories = [memory("a", "user prefers atomic commits", "v1"), memory("b", "gardening note", "tomatoes")];
    await ensureMemoriesEmbedded(memories, { apiKey: "test" }, apiBaseUrl);
    const afterFirst = embedRequestCount;

    const updated = [memory("a", "user prefers atomic commits", "v2 — a real content change"), memories[1]!];
    await ensureMemoriesEmbedded(updated, { apiKey: "test" }, apiBaseUrl);
    expect(embedRequestCount).toBe(afterFirst + 1); // only "a"'s new content, not "b" again
  });
});
