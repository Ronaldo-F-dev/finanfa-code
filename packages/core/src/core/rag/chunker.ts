import type { LoadedDocument } from "./document-loader.js";

// A straightforward sliding-window, character-count-based splitter — no
// sentence/paragraph-boundary awareness. That's a natural future
// improvement (chunking on paragraph/heading boundaries would read
// better and cite more cleanly) but a fixed-size window is simple,
// correct, and enough for phase 5's embedding/vector-store work to plug
// into; nothing downstream depends on chunk boundaries being "clean".

export interface ChunkOptions {
  /** Characters per chunk. Default 1000 (~roughly 200-250 tokens for typical English prose). */
  chunkSize?: number;
  /** Characters of overlap between consecutive chunks, so a fact split across a chunk boundary still appears whole in at least one chunk. Default 200. */
  overlap?: number;
}

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 200;

export interface TextChunk {
  text: string;
  /** Index of this chunk within the sequence produced for its source text, starting at 0. */
  chunkIndex: number;
  /** Character offset range into the ORIGINAL text this chunk was cut from — [startOffset, endOffset) — so later phases can cite "this came from position X of file Y." */
  startOffset: number;
  endOffset: number;
}

/**
 * Splits arbitrary text into overlapping fixed-size chunks. Works on any
 * already-loaded text — not tied to DocumentLoader's output — so it stays
 * usable on its own (e.g. chunking a tool result or pasted text later).
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;
  if (chunkSize <= 0) throw new Error("chunkSize must be positive");
  if (overlap < 0 || overlap >= chunkSize) throw new Error("overlap must be >= 0 and less than chunkSize");

  if (text.length === 0) return [];

  const chunks: TextChunk[] = [];
  const stride = chunkSize - overlap;
  let start = 0;
  let chunkIndex = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push({ text: text.slice(start, end), chunkIndex, startOffset: start, endOffset: end });
    chunkIndex++;
    if (end >= text.length) break;
    start += stride;
  }
  return chunks;
}

export interface DocumentChunk extends TextChunk {
  /** Source document this chunk came from, for later citation ("this came from file Y"). */
  sourcePath: string;
  /** The source document's contentHash at load time — lets phase 5 key a chunk's embedding by (contentHash, chunkIndex) and skip re-embedding when the file hasn't changed, the same cache-by-hash pattern memory-search-index.ts already uses for whole notes. */
  documentContentHash: string;
}

/** Chunks a LoadedDocument's text, attaching source-document metadata (path + content hash) to every chunk so it's traceable back after being split up. */
export function chunkDocument(document: LoadedDocument, options: ChunkOptions = {}): DocumentChunk[] {
  return chunkText(document.text, options).map((chunk) => ({
    ...chunk,
    sourcePath: document.sourcePath,
    documentContentHash: document.contentHash,
  }));
}
