import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VectorStore, resetVectorStoreForTests } from "../../../src/core/rag/vector-store.js";
import type { LoadedDocument } from "../../../src/core/rag/document-loader.js";
import type { DocumentChunk } from "../../../src/core/rag/chunker.js";

function doc(sourcePath: string, contentHash: string): LoadedDocument {
  return { sourcePath, type: "text", text: "irrelevant for the store itself", mtimeMs: 0, contentHash };
}

function chunk(sourcePath: string, contentHash: string, chunkIndex: number, text: string): DocumentChunk {
  return { sourcePath, documentContentHash: contentHash, chunkIndex, text, startOffset: chunkIndex * 10, endOffset: chunkIndex * 10 + text.length };
}

describe("VectorStore (real node:sqlite file, per project cwd)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "finanfa-vector-store-"));
    resetVectorStoreForTests();
  });

  afterEach(async () => {
    resetVectorStoreForTests();
    await rm(cwd, { recursive: true, force: true });
  });

  it("upserts a document's chunks and finds them by search", () => {
    const store = new VectorStore(cwd);
    const d = doc("/a.txt", "hash1");
    const chunks = [chunk("/a.txt", "hash1", 0, "cats are great pets"), chunk("/a.txt", "hash1", 1, "the stock market fell today")];
    store.upsertDocument(d, chunks, [
      [1, 0],
      [0, 1],
    ]);

    const hits = store.search([1, 0], 5);
    expect(hits[0]?.text).toBe("cats are great pets");
    expect(hits[0]?.similarity).toBeCloseTo(1, 10);
    expect(hits.at(-1)?.text).toBe("the stock market fell today");
  });

  it("lists stored documents with their chunk count", () => {
    const store = new VectorStore(cwd);
    store.upsertDocument(doc("/a.txt", "h1"), [chunk("/a.txt", "h1", 0, "one"), chunk("/a.txt", "h1", 1, "two")], [[1, 0], [0, 1]]);
    store.upsertDocument(doc("/b.txt", "h2"), [chunk("/b.txt", "h2", 0, "three")], [[1, 1]]);

    const listed = store.listDocuments().sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    expect(listed).toEqual([
      { sourcePath: "/a.txt", contentHash: "h1", chunkCount: 2 },
      { sourcePath: "/b.txt", contentHash: "h2", chunkCount: 1 },
    ]);
  });

  it("removeDocument deletes a document and all of its chunks", () => {
    const store = new VectorStore(cwd);
    store.upsertDocument(doc("/a.txt", "h1"), [chunk("/a.txt", "h1", 0, "one")], [[1, 0]]);
    store.removeDocument("/a.txt");

    expect(store.listDocuments()).toEqual([]);
    expect(store.search([1, 0], 5)).toEqual([]);
  });

  it("re-upserting the same content hash is a no-op (doesn't touch existing chunks)", () => {
    const store = new VectorStore(cwd);
    store.upsertDocument(doc("/a.txt", "h1"), [chunk("/a.txt", "h1", 0, "one")], [[1, 0]]);
    // A second upsert with the SAME hash but deliberately-wrong chunks/embeddings
    // must be ignored — otherwise "unchanged content" would still cost a
    // pointless re-embed-and-store on every call.
    store.upsertDocument(doc("/a.txt", "h1"), [chunk("/a.txt", "h1", 0, "SHOULD NOT APPEAR")], [[0, 1]]);

    const listed = store.listDocuments();
    expect(listed).toEqual([{ sourcePath: "/a.txt", contentHash: "h1", chunkCount: 1 }]);
    expect(store.search([1, 0], 5)[0]?.text).toBe("one");
  });

  it("re-upserting with a CHANGED content hash replaces the old chunks, including shrinking chunk count", () => {
    const store = new VectorStore(cwd);
    store.upsertDocument(
      doc("/a.txt", "h1"),
      [chunk("/a.txt", "h1", 0, "one"), chunk("/a.txt", "h1", 1, "two"), chunk("/a.txt", "h1", 2, "three")],
      [[1, 0], [0, 1], [1, 1]],
    );
    store.upsertDocument(doc("/a.txt", "h2"), [chunk("/a.txt", "h2", 0, "only chunk now")], [[1, 0]]);

    const listed = store.listDocuments();
    expect(listed).toEqual([{ sourcePath: "/a.txt", contentHash: "h2", chunkCount: 1 }]);
    const hits = store.search([1, 0], 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe("only chunk now");
  });

  it("throws when chunks and embeddings lengths mismatch", () => {
    const store = new VectorStore(cwd);
    expect(() => store.upsertDocument(doc("/a.txt", "h1"), [chunk("/a.txt", "h1", 0, "one")], [])).toThrow(/length mismatch/);
  });

  it("persists to disk — a freshly reopened handle on the same cwd sees earlier writes", () => {
    new VectorStore(cwd).upsertDocument(doc("/a.txt", "h1"), [chunk("/a.txt", "h1", 0, "one")], [[1, 0]]);
    resetVectorStoreForTests(); // force a real reopen from disk, not the cached in-process handle
    const reopened = new VectorStore(cwd);
    expect(reopened.listDocuments()).toEqual([{ sourcePath: "/a.txt", contentHash: "h1", chunkCount: 1 }]);
  });
});
