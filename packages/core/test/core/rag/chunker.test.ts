import { describe, expect, it } from "vitest";
import { chunkText, chunkDocument } from "../../../src/core/rag/chunker.js";
import type { LoadedDocument } from "../../../src/core/rag/document-loader.js";

describe("chunkText", () => {
  it("returns a single chunk when text fits within chunkSize", () => {
    const chunks = chunkText("short text", { chunkSize: 1000, overlap: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ text: "short text", chunkIndex: 0, startOffset: 0, endOffset: 10 });
  });

  it("returns no chunks for empty text", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("splits into the expected number of overlapping chunks for known input size", () => {
    // 250 chars, chunkSize 100, overlap 20 -> stride 80
    // starts: 0 (end 100), 80 (end 180), 160 (end 250, clipped and >= text.length so stop) -> 3 chunks
    const text = "x".repeat(250);
    const chunks = chunkText(text, { chunkSize: 100, overlap: 20 });

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ chunkIndex: 0, startOffset: 0, endOffset: 100 });
    expect(chunks[1]).toMatchObject({ chunkIndex: 1, startOffset: 80, endOffset: 180 });
    expect(chunks[2]).toMatchObject({ chunkIndex: 2, startOffset: 160, endOffset: 250 });
  });

  it("produces chunks whose overlap region has matching text", () => {
    const text = "abcdefghijklmnopqrstuvwxyz".repeat(10); // 260 chars
    const chunks = chunkText(text, { chunkSize: 100, overlap: 30 });
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const cur = chunks[i]!;
      const overlapLen = prev.endOffset - cur.startOffset;
      expect(overlapLen).toBeGreaterThan(0);
      expect(prev.text.slice(prev.text.length - overlapLen)).toBe(cur.text.slice(0, overlapLen));
    }
  });

  it("uses sensible defaults when no options are given", () => {
    const text = "y".repeat(2500);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.text.length).toBe(1000);
  });

  it("rejects an overlap that is not smaller than chunkSize", () => {
    expect(() => chunkText("abc", { chunkSize: 100, overlap: 100 })).toThrow(/overlap/);
    expect(() => chunkText("abc", { chunkSize: 100, overlap: 200 })).toThrow(/overlap/);
  });

  it("rejects a non-positive chunkSize", () => {
    expect(() => chunkText("abc", { chunkSize: 0 })).toThrow(/chunkSize/);
  });
});

describe("chunkDocument", () => {
  it("attaches source path and content hash to every chunk", () => {
    const document: LoadedDocument = {
      sourcePath: "/tmp/example.md",
      type: "markdown",
      text: "z".repeat(150),
      mtimeMs: 12345,
      contentHash: "deadbeef",
    };

    const chunks = chunkDocument(document, { chunkSize: 50, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.sourcePath).toBe("/tmp/example.md");
      expect(chunk.documentContentHash).toBe("deadbeef");
    }
    // positions still reference the original document text, chunk-index ordered
    expect(chunks[0]!.startOffset).toBe(0);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });
});
