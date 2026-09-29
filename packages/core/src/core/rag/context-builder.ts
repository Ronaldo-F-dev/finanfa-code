import type { RetrievedChunk } from "./retriever.js";

// Phase 6's other half: formats Retriever's ranked chunks into a clean text
// block a prompt can actually use. No citation/contradiction-handling here
// (phase 8) — just visibly carrying the source info through, since phase 8
// will need it and it costs nothing to include now.

export interface ContextBuilderOptions {
  /** Character budget for the whole formatted block. Default 8000 — generous for a few chunks' worth of context without risking blowing a small model's context window on its own. */
  maxChars?: number;
}

export interface BuiltContext {
  /** The formatted context block, ready to splice into a prompt. Empty string if no chunks were included. */
  text: string;
  /** The chunks actually included, highest score first — a subset of the input if some were dropped for budget. */
  includedChunks: RetrievedChunk[];
  /**
   * True if one or more input chunks were left out because of `maxChars`,
   * not because there simply weren't more results. Lets a caller tell "the
   * index had more relevant material than fit" apart from "this is
   * genuinely everything relevant" — the two look identical in a bare
   * formatted string.
   */
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 8000;
const SEPARATOR = "\n\n---\n\n";

function formatChunk(chunk: RetrievedChunk, rank: number): string {
  const title = chunk.frontmatter?.title;
  const titlePart = typeof title === "string" ? `, "${title}"` : "";
  const header = `[${rank}] ${chunk.sourcePath} (chunk ${chunk.chunkIndex}, chars ${chunk.startOffset}-${chunk.endOffset}${titlePart}, relevance ${chunk.score.toFixed(3)})`;
  return `${header}\n${chunk.text}`;
}

/**
 * Formats retrieved chunks into a single delimited text block, highest
 * relevance first, within a character budget. Chunks are considered in rank
 * order and included whole — the first chunk that would push the block over
 * `maxChars` stops inclusion there (remaining, lower-ranked chunks are
 * dropped too) rather than truncating a chunk's text mid-sentence, which
 * would make its content misleading.
 */
export function buildContext(chunks: RetrievedChunk[], options: ContextBuilderOptions = {}): BuiltContext {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const ranked = [...chunks].sort((a, b) => b.score - a.score);

  const includedChunks: RetrievedChunk[] = [];
  const parts: string[] = [];
  let used = 0;

  for (const chunk of ranked) {
    const formatted = formatChunk(chunk, includedChunks.length + 1);
    const additional = formatted.length + (parts.length > 0 ? SEPARATOR.length : 0);
    if (used + additional > maxChars) break;
    parts.push(formatted);
    used += additional;
    includedChunks.push(chunk);
  }

  return {
    text: parts.join(SEPARATOR),
    includedChunks,
    truncated: includedChunks.length < ranked.length,
  };
}
