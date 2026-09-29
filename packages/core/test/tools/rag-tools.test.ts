import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FinanfaConfig } from "../../src/core/config.js";
import {
  createIndexProjectDocumentsTool,
  createSearchProjectDocumentsTool,
  createCheckClaimGroundingTool,
} from "../../src/tools/builtin/rag-tools.js";
import { resetVectorStoreForTests } from "../../src/core/rag/vector-store.js";
import { LocalTransformersEmbeddingProvider } from "../../src/core/rag/embedding-provider.js";
import type { EmbeddingProvider } from "../../src/core/rag/embedding-provider.js";

// Phase 7: exercises the two RAG builtin tools with a real small on-disk
// corpus and the real local (zero-config) embedding provider — same
// approach phase5-integration.test.ts/retriever.test.ts already
// established, no mocked embedding calls.

const ctx = (cwd: string) => ({ cwd, sessionId: "current", signal: new AbortController().signal });
const config: FinanfaConfig = {};

/** Counts real embed() calls made through it, to prove indexing skips unchanged files on a second run rather than just observing behavior. */
class CountingEmbeddingProvider implements EmbeddingProvider {
  callCount = 0;
  constructor(private readonly inner: EmbeddingProvider) {}
  get dimensions() {
    return this.inner.dimensions;
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.callCount += texts.length === 0 ? 0 : 1;
    return this.inner.embed(texts);
  }
}

describe("RAG builtin tools (real corpus, real local embedding provider)", () => {
  let cwd: string;
  const baseProvider = new LocalTransformersEmbeddingProvider();

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "finanfa-rag-tools-"));
    resetVectorStoreForTests();
  });

  afterEach(async () => {
    resetVectorStoreForTests();
    await rm(cwd, { recursive: true, force: true });
  });

  it("index_project_documents indexes a real small directory and reports accurate counts", async () => {
    await writeFile(
      path.join(cwd, "baking.txt"),
      "To bake a great chocolate cake, cream the butter and sugar together, then fold in cocoa powder and flour. " +
        "Bake at 350 degrees Fahrenheit for about thirty minutes until a toothpick comes out clean.",
      "utf-8",
    );
    await writeFile(
      path.join(cwd, "finance.txt"),
      "Quarterly earnings exceeded analyst expectations, driven by strong revenue growth in the cloud computing division.",
      "utf-8",
    );

    const indexTool = createIndexProjectDocumentsTool(config, baseProvider);
    const result = await indexTool.handler({}, ctx(cwd));

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Indexed 2 document(s)");
    expect(result.content).toContain("skipped 0 unchanged, 0 failed");
    expect((result.metadata?.summary as { documentsIndexed: number }).documentsIndexed).toBe(2);
  }, 120_000);

  it("running index_project_documents twice on an unchanged directory reports the second run's skip counts and does no re-embedding", async () => {
    await writeFile(path.join(cwd, "a.txt"), "content about penguins and antarctica", "utf-8");
    await writeFile(path.join(cwd, "b.txt"), "content about volcanoes and lava", "utf-8");

    const counting = new CountingEmbeddingProvider(baseProvider);
    const indexTool = createIndexProjectDocumentsTool(config, counting);

    const first = await indexTool.handler({}, ctx(cwd));
    expect(first.content).toContain("Indexed 2 document(s)");
    const callsAfterFirst = counting.callCount;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await indexTool.handler({}, ctx(cwd));
    expect(second.isError).toBe(false);
    expect(second.content).toContain("Indexed 0 document(s)");
    expect(second.content).toContain("skipped 2 unchanged, 0 failed");
    expect(counting.callCount).toBe(callsAfterFirst); // no new embed() calls on the unchanged second run
  }, 120_000);

  it("search_project_documents returns real, relevant results for a real query against an indexed corpus", async () => {
    await writeFile(
      path.join(cwd, "baking.md"),
      [
        "---",
        "title: Chocolate Cake Recipe",
        "---",
        "",
        "To bake a great chocolate cake, cream the butter and sugar together, then fold in cocoa powder and flour. " +
          "Bake at 350 degrees Fahrenheit for about thirty minutes until a toothpick comes out clean.",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(cwd, "finance.txt"),
      "Quarterly earnings exceeded analyst expectations, driven by strong revenue growth in the cloud computing division.",
      "utf-8",
    );

    const indexTool = createIndexProjectDocumentsTool(config, baseProvider);
    await indexTool.handler({}, ctx(cwd));

    const searchTool = createSearchProjectDocumentsTool(config, baseProvider);
    const result = await searchTool.handler({ query: "What temperature should I use to bake a cake?" }, ctx(cwd));

    expect(result.isError).toBe(false);
    expect(result.content).toContain("baking.md");
    expect(result.content).toContain("Chocolate Cake Recipe");
    expect(result.content).toMatch(/350 degrees/);
  }, 120_000);

  it("search_project_documents against a never-indexed project directory returns a clear, honest message pointing at index_project_documents", async () => {
    const searchTool = createSearchProjectDocumentsTool(config, baseProvider);
    const result = await searchTool.handler({ query: "anything at all" }, ctx(cwd));

    expect(result.isError).toBe(false);
    expect(result.content).toContain("index_project_documents");
    expect(result.content.toLowerCase()).toContain("no documents have been indexed");
  });

  it("index_project_documents has riskLevel 'ask', matching write_memory's precedent (writes real local state)", () => {
    const indexTool = createIndexProjectDocumentsTool(config, baseProvider);
    expect(indexTool.riskLevel).toBe("ask");
  });

  it("search_project_documents has riskLevel 'safe', matching search_memories/recall_past_sessions' precedent (pure local read)", () => {
    const searchTool = createSearchProjectDocumentsTool(config, baseProvider);
    expect(searchTool.riskLevel).toBe("safe");
  });

  describe("check_claim_grounding", () => {
    it("returns a real, sensible similarity score and correct source attribution for a claim closely matching indexed content", async () => {
      await writeFile(
        path.join(cwd, "baking.md"),
        [
          "---",
          "title: Chocolate Cake Recipe",
          "---",
          "",
          "To bake a great chocolate cake, cream the butter and sugar together, then fold in cocoa powder and flour. " +
            "Bake at 350 degrees Fahrenheit for about thirty minutes until a toothpick comes out clean.",
        ].join("\n"),
        "utf-8",
      );

      const indexTool = createIndexProjectDocumentsTool(config, baseProvider);
      await indexTool.handler({}, ctx(cwd));

      const groundingTool = createCheckClaimGroundingTool(config, baseProvider);
      const result = await groundingTool.handler({ claim: "Chocolate cake should bake at 350 degrees Fahrenheit." }, ctx(cwd));

      expect(result.isError).toBe(false);
      expect(result.content).toContain("baking.md");
      expect(result.content).toMatch(/relevance 0\.\d+/);
      const bestScore = result.metadata?.bestScore as number;
      expect(bestScore).toBeGreaterThan(0.3); // real, meaningfully high similarity for a near-restatement
      expect(result.content).toContain("not a fact-check");
    }, 120_000);

    it("a claim unrelated to anything indexed gets a low score and doesn't crash/misreport when nothing indexed is close", async () => {
      await writeFile(
        path.join(cwd, "baking.txt"),
        "To bake a great chocolate cake, cream the butter and sugar together, then fold in cocoa powder and flour.",
        "utf-8",
      );

      const indexTool = createIndexProjectDocumentsTool(config, baseProvider);
      await indexTool.handler({}, ctx(cwd));

      const groundingTool = createCheckClaimGroundingTool(config, baseProvider);
      const result = await groundingTool.handler({ claim: "The stock market crashed due to rising interest rates in 1987." }, ctx(cwd));

      expect(result.isError).toBe(false);
      const bestScore = result.metadata?.bestScore as number | undefined;
      if (bestScore !== undefined) {
        expect(bestScore).toBeLessThan(0.3); // real, meaningfully low similarity for an unrelated topic
      } else {
        expect(result.content.toLowerCase()).toContain("no indexed chunk");
      }
    }, 120_000);

    it("reports a clear message when nothing has been indexed yet", async () => {
      const groundingTool = createCheckClaimGroundingTool(config, baseProvider);
      const result = await groundingTool.handler({ claim: "anything at all" }, ctx(cwd));

      expect(result.isError).toBe(false);
      expect(result.content).toContain("index_project_documents");
    });

    it("has riskLevel 'safe', matching search_project_documents' precedent (pure local read, no side effects)", () => {
      const groundingTool = createCheckClaimGroundingTool(config, baseProvider);
      expect(groundingTool.riskLevel).toBe("safe");
    });

    it("states its similarity-signal-not-a-fact-checker limitation plainly in its own tool description", () => {
      const groundingTool = createCheckClaimGroundingTool(config, baseProvider);
      const description = groundingTool.description.toLowerCase();
      expect(description).toContain("not a fact-checker");
      expect(description).toContain("contradicts it");
      expect(description).toContain("score low if the indexed documents simply don't cover it");
    });
  });

  describe("search_project_documents multi-source structural signal", () => {
    it("appears when results genuinely span multiple distinct documents with meaningful relevance", async () => {
      await writeFile(
        path.join(cwd, "recipe-a.md"),
        "Chocolate cake baking instructions: cream butter and sugar, fold in cocoa powder and flour, bake at 350 degrees.",
        "utf-8",
      );
      await writeFile(
        path.join(cwd, "recipe-b.md"),
        "Another chocolate cake guide: mix butter, sugar and cocoa, then bake the batter at 350 degrees Fahrenheit.",
        "utf-8",
      );
      await writeFile(
        path.join(cwd, "unrelated.md"),
        "Quarterly earnings exceeded analyst expectations, driven by cloud computing revenue growth.",
        "utf-8",
      );

      const indexTool = createIndexProjectDocumentsTool(config, baseProvider);
      await indexTool.handler({}, ctx(cwd));

      const searchTool = createSearchProjectDocumentsTool(config, baseProvider);
      const result = await searchTool.handler({ query: "How do I bake a chocolate cake?", topK: 8 }, ctx(cwd));

      expect(result.isError).toBe(false);
      expect(result.content).toContain("different documents");
      expect(result.content).toContain("recipe-a.md");
      expect(result.content).toContain("recipe-b.md");
      expect(result.content.toLowerCase()).toContain("not that they disagree");
    }, 120_000);

    it("does NOT appear when results are multiple chunks from the same single document", async () => {
      const longSameDocText = Array.from(
        { length: 6 },
        (_, i) =>
          `Section ${i}: this part of the handbook explains company vacation policy in detail, including how many days off employees accrue per year and how to request time off through the portal.`,
      ).join("\n\n");
      await writeFile(path.join(cwd, "handbook.md"), longSameDocText, "utf-8");

      const indexTool = createIndexProjectDocumentsTool(config, baseProvider);
      await indexTool.handler({}, ctx(cwd));

      const searchTool = createSearchProjectDocumentsTool(config, baseProvider);
      const result = await searchTool.handler({ query: "vacation policy and time off", topK: 8 }, ctx(cwd));

      expect(result.isError).toBe(false);
      expect(result.content).toContain("handbook.md");
      expect(result.content).not.toContain("different documents");
    }, 120_000);
  });
});
