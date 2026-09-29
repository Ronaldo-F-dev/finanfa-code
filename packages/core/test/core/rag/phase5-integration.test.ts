import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDocument } from "../../../src/core/rag/document-loader.js";
import { chunkDocument } from "../../../src/core/rag/chunker.js";
import { LocalTransformersEmbeddingProvider } from "../../../src/core/rag/embedding-provider.js";
import { VectorStore, resetVectorStoreForTests } from "../../../src/core/rag/vector-store.js";

// End-to-end Phase 5 check: a real document, loaded and chunked by Phase 4,
// embedded for real by the zero-config local provider, stored in a real
// SQLite-backed VectorStore, and searched with a real query — confirming
// the most relevant chunk genuinely ranks first, not asserting against a
// mocked embedding.
describe("Phase 5 integration: load -> chunk -> embed -> store -> semantic search", () => {
  let cwd: string;
  const provider = new LocalTransformersEmbeddingProvider();

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "finanfa-rag-integration-"));
    resetVectorStoreForTests();
  });

  afterEach(async () => {
    resetVectorStoreForTests();
    await rm(cwd, { recursive: true, force: true });
  });

  it("ranks the genuinely relevant chunk first in a real small corpus", async () => {
    const bakingPath = path.join(cwd, "baking.txt");
    const financePath = path.join(cwd, "finance.txt");
    await writeFile(
      bakingPath,
      "To bake a great chocolate cake, cream the butter and sugar together, then fold in cocoa powder and flour. " +
        "Bake at 350 degrees Fahrenheit for about thirty minutes until a toothpick comes out clean.",
      "utf-8",
    );
    await writeFile(
      financePath,
      "Quarterly earnings exceeded analyst expectations, driven by strong revenue growth in the cloud computing division. " +
        "The board approved a share buyback program in response to the results.",
      "utf-8",
    );

    const store = new VectorStore(cwd);
    for (const filePath of [bakingPath, financePath]) {
      const document = await loadDocument(filePath);
      const chunks = chunkDocument(document, { chunkSize: 500, overlap: 50 });
      const embeddings = await provider.embed(chunks.map((c) => c.text));
      store.upsertDocument(document, chunks, embeddings);
    }

    const [queryVector] = await provider.embed(["What temperature should I use to bake a cake?"]);
    const hits = store.search(queryVector!, 5);

    expect(hits[0]?.sourcePath).toBe(bakingPath);
    expect(hits[0]?.similarity).toBeGreaterThan(hits.at(-1)!.similarity);
    expect(hits.at(-1)?.sourcePath).toBe(financePath);
  }, 120_000);

  it("re-loading a changed file invalidates its old chunks in the store", async () => {
    const filePath = path.join(cwd, "note.txt");
    await writeFile(filePath, "version one content about gardening and tomatoes", "utf-8");

    const store = new VectorStore(cwd);
    const v1 = await loadDocument(filePath);
    const v1Chunks = chunkDocument(v1);
    store.upsertDocument(v1, v1Chunks, await provider.embed(v1Chunks.map((c) => c.text)));
    expect(store.listDocuments()[0]?.contentHash).toBe(v1.contentHash);

    await writeFile(filePath, "version two: a completely different topic about spacecraft propulsion", "utf-8");
    const v2 = await loadDocument(filePath);
    expect(v2.contentHash).not.toBe(v1.contentHash);
    const v2Chunks = chunkDocument(v2);
    store.upsertDocument(v2, v2Chunks, await provider.embed(v2Chunks.map((c) => c.text)));

    const documents = store.listDocuments();
    expect(documents).toHaveLength(1);
    expect(documents[0]?.contentHash).toBe(v2.contentHash);
    const allChunks = store.search(await provider.embed(["spacecraft"]).then((v) => v[0]!), 10);
    expect(allChunks.every((c) => c.text.includes("spacecraft") || c.text.includes("propulsion"))).toBe(true);
  }, 120_000);
});
