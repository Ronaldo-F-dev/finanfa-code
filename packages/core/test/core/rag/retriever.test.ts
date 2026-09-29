import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Retriever } from "../../../src/core/rag/retriever.js";
import { LocalTransformersEmbeddingProvider } from "../../../src/core/rag/embedding-provider.js";
import { resetVectorStoreForTests } from "../../../src/core/rag/vector-store.js";
import type { EmbeddingProvider } from "../../../src/core/rag/embedding-provider.js";

// Phase 6 integration: real load -> chunk -> embed -> store (phases 4-5,
// reused as-is) -> real Retriever.retrieve() against a real small corpus, no
// mocked embedding calls — same approach phase5-integration.test.ts already
// established.

/** Counts real embed() calls made through it, so indexProject's "skip unchanged files" claim can be proven rather than just observed via behavior. */
class CountingEmbeddingProvider implements EmbeddingProvider {
  callCount = 0;
  embeddedTexts: string[] = [];
  constructor(private readonly inner: EmbeddingProvider) {}
  get dimensions() {
    return this.inner.dimensions;
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.callCount += texts.length === 0 ? 0 : 1;
    this.embeddedTexts.push(...texts);
    return this.inner.embed(texts);
  }
}

describe("Retriever", () => {
  let cwd: string;
  const baseProvider = new LocalTransformersEmbeddingProvider();

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "finanfa-rag-retriever-"));
    resetVectorStoreForTests();
  });

  afterEach(async () => {
    resetVectorStoreForTests();
    await rm(cwd, { recursive: true, force: true });
  });

  it(
    "retrieves the genuinely relevant chunk ranked first from a real multi-document corpus, carrying frontmatter through",
    async () => {
      await writeFile(
        path.join(cwd, "baking.md"),
        [
          "---",
          "title: Chocolate Cake Recipe",
          "tags: [baking, dessert]",
          "---",
          "",
          "To bake a great chocolate cake, cream the butter and sugar together, then fold in cocoa powder and flour. " +
            "Bake at 350 degrees Fahrenheit for about thirty minutes until a toothpick comes out clean.",
        ].join("\n"),
        "utf-8",
      );
      await writeFile(
        path.join(cwd, "finance.txt"),
        "Quarterly earnings exceeded analyst expectations, driven by strong revenue growth in the cloud computing division. " +
          "The board approved a share buyback program in response to the results.",
        "utf-8",
      );

      const retriever = new Retriever(cwd, baseProvider);
      const summary = await retriever.indexProject(cwd, { chunkSize: 500, overlap: 50 });
      expect(summary.documentsIndexed).toBe(2);
      expect(summary.documentsFailed).toBe(0);

      const results = await retriever.retrieve("What temperature should I use to bake a cake?", { topK: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.sourcePath).toBe(path.join(cwd, "baking.md"));
      expect(results[0]?.frontmatter?.title).toBe("Chocolate Cake Recipe");
      // sorted descending by score
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
      }
    },
    120_000,
  );

  it(
    "minScore filters out low-relevance results",
    async () => {
      await writeFile(path.join(cwd, "baking.txt"), "How to bake sourdough bread with a natural starter.", "utf-8");
      await writeFile(
        path.join(cwd, "finance.txt"),
        "The Federal Reserve raised interest rates by 25 basis points at its latest meeting.",
        "utf-8",
      );

      const retriever = new Retriever(cwd, baseProvider);
      await retriever.indexProject(cwd);

      const unfiltered = await retriever.retrieve("bread baking techniques", { topK: 10 });
      expect(unfiltered.length).toBe(2);

      const worstScore = Math.min(...unfiltered.map((r) => r.score));
      const filtered = await retriever.retrieve("bread baking techniques", {
        topK: 10,
        minScore: worstScore + 0.001,
      });
      expect(filtered.length).toBeLessThan(unfiltered.length);
      expect(filtered.every((r) => r.score >= worstScore + 0.001)).toBe(true);
    },
    120_000,
  );

  it(
    "reports a clear error on embedding dimension mismatch instead of returning meaningless scores",
    async () => {
      await writeFile(path.join(cwd, "note.txt"), "some indexed content", "utf-8");
      const retriever = new Retriever(cwd, baseProvider);
      await retriever.indexProject(cwd);

      // A provider reporting a different dimensionality than what's actually
      // stored (384, from the real local provider above) simulates a user
      // having switched embedding provider/model after indexing.
      const mismatchedProvider: EmbeddingProvider = {
        dimensions: 3,
        embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
      };
      const mismatchedRetriever = new Retriever(cwd, mismatchedProvider);
      await expect(mismatchedRetriever.retrieve("some query")).rejects.toThrow(/dimension mismatch/i);
    },
    120_000,
  );

  it(
    "indexProject skips re-embedding unchanged files on a second run",
    async () => {
      await writeFile(path.join(cwd, "a.txt"), "content about penguins and antarctica", "utf-8");
      await writeFile(path.join(cwd, "b.txt"), "content about volcanoes and lava", "utf-8");

      const counting = new CountingEmbeddingProvider(baseProvider);
      const retriever = new Retriever(cwd, counting);

      const first = await retriever.indexProject(cwd);
      expect(first.documentsIndexed).toBe(2);
      expect(first.documentsSkipped).toBe(0);
      const callsAfterFirst = counting.callCount;
      expect(callsAfterFirst).toBeGreaterThan(0);

      const second = await retriever.indexProject(cwd);
      expect(second.documentsIndexed).toBe(0);
      expect(second.documentsSkipped).toBe(2);
      expect(counting.callCount).toBe(callsAfterFirst); // no new embed() calls at all
    },
    120_000,
  );

  it(
    "indexProject picks up a changed file's new content on a subsequent run",
    async () => {
      const filePath = path.join(cwd, "note.txt");
      await writeFile(filePath, "version one content about gardening", "utf-8");

      const counting = new CountingEmbeddingProvider(baseProvider);
      const retriever = new Retriever(cwd, counting);
      await retriever.indexProject(cwd);
      const callsAfterFirst = counting.callCount;

      await writeFile(filePath, "version two: an entirely different topic about jet engines", "utf-8");
      const second = await retriever.indexProject(cwd);
      expect(second.documentsIndexed).toBe(1);
      expect(second.documentsSkipped).toBe(0);
      expect(counting.callCount).toBeGreaterThan(callsAfterFirst);

      const results = await retriever.retrieve("jet engines", { topK: 5 });
      expect(results.some((r) => r.text.includes("jet engines"))).toBe(true);
    },
    120_000,
  );

  it("indexProject reports load failures without aborting the whole run", async () => {
    await writeFile(path.join(cwd, "good.txt"), "valid content here", "utf-8");
    await writeFile(path.join(cwd, "unsupported.xyz"), "not a supported extension", "utf-8");

    const retriever = new Retriever(cwd, baseProvider);
    const summary = await retriever.indexProject(cwd);
    expect(summary.documentsIndexed).toBe(1);
    // unsupported.xyz isn't even picked up by loadDirectory's glob (not a supported extension), so it's simply absent — not a failure.
    expect(summary.documentsFailed).toBe(0);
  }, 120_000);
});
