import { describe, expect, it } from "vitest";
import { buildContext } from "../../../src/core/rag/context-builder.js";
import type { RetrievedChunk } from "../../../src/core/rag/retriever.js";

function chunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    text: "default text",
    score: 0.5,
    sourcePath: "/tmp/doc.txt",
    chunkIndex: 0,
    startOffset: 0,
    endOffset: 12,
    ...overrides,
  };
}

describe("buildContext", () => {
  it("orders chunks by score descending regardless of input order, and delimits them with visible source info", () => {
    const low = chunk({ text: "low relevance chunk", score: 0.2, sourcePath: "/tmp/low.txt", chunkIndex: 1 });
    const high = chunk({ text: "high relevance chunk", score: 0.9, sourcePath: "/tmp/high.txt", chunkIndex: 0 });
    const mid = chunk({ text: "mid relevance chunk", score: 0.5, sourcePath: "/tmp/mid.txt", chunkIndex: 2 });

    const result = buildContext([low, high, mid]);

    expect(result.includedChunks.map((c) => c.sourcePath)).toEqual(["/tmp/high.txt", "/tmp/mid.txt", "/tmp/low.txt"]);
    expect(result.truncated).toBe(false);

    const highIdx = result.text.indexOf("high relevance chunk");
    const midIdx = result.text.indexOf("mid relevance chunk");
    const lowIdx = result.text.indexOf("low relevance chunk");
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);

    // source file + chunk position visible in the formatted output
    expect(result.text).toContain("/tmp/high.txt");
    expect(result.text).toContain("chunk 0");
  });

  it("surfaces frontmatter title in the formatted header when present", () => {
    const withTitle = chunk({ frontmatter: { title: "My Doc Title" } });
    const result = buildContext([withTitle]);
    expect(result.text).toContain("My Doc Title");
  });

  it("returns empty text and truncated=false for no input chunks", () => {
    const result = buildContext([]);
    expect(result.text).toBe("");
    expect(result.includedChunks).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("respects maxChars, including as many highest-ranked whole chunks as fit, and reports truncation", () => {
    const chunks = Array.from({ length: 20 }, (_, i) =>
      chunk({ text: "x".repeat(200), score: 1 - i * 0.01, sourcePath: `/tmp/doc${i}.txt`, chunkIndex: i }),
    );

    const result = buildContext(chunks, { maxChars: 500 });

    expect(result.includedChunks.length).toBeGreaterThan(0);
    expect(result.includedChunks.length).toBeLessThan(chunks.length);
    expect(result.text.length).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(true);
    // included chunks are exactly the highest-ranked prefix
    expect(result.includedChunks.map((c) => c.sourcePath)).toEqual(
      chunks.slice(0, result.includedChunks.length).map((c) => c.sourcePath),
    );
    // no mid-chunk truncation: every included chunk's full text appears intact
    for (const included of result.includedChunks) {
      expect(result.text).toContain(included.text);
    }
  });

  it("does not report truncation when everything fits within the budget", () => {
    const chunks = [chunk({ text: "short" }), chunk({ text: "also short", sourcePath: "/tmp/other.txt" })];
    const result = buildContext(chunks, { maxChars: 10_000 });
    expect(result.includedChunks).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });
});
