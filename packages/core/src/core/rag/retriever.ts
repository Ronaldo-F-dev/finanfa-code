import { loadDirectory } from "./document-loader.js";
import { chunkDocument, type ChunkOptions } from "./chunker.js";
import { VectorStore } from "./vector-store.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

// Phase 6 of the RAG rollout: given a natural-language query, get back a
// ranked set of relevant chunks. Purely a library — nothing here is wired
// into the agent loop or exposed as a tool yet (that's phase 7).

// RAG rollout complete (phases 1-8). End to end, finanfa-code's RAG now
// lets the agent: index a project's documents on demand
// (index_project_documents, this file's indexProject); search them by
// meaning rather than exact wording (search_project_documents, this file's
// retrieve, formatted with source-attributed citations by
// context-builder.ts); spot-check a specific claim against the index
// (check_claim_grounding); and get a note when a search result spans
// multiple distinct source documents, as a prompt to cross-check them.
// Real, honest limitations, not caveats to gloss over: there is no true
// semantic contradiction detection anywhere in this system — the
// multi-source note flags "more than one document answered this", never
// "these documents disagree", because nothing here compares meaning across
// chunks. check_claim_grounding is a similarity signal, not a certified
// fact-checker — high similarity can still be a contradicting chunk with
// similar wording, and a true claim can score low if the index just
// doesn't cover it. Retrieval quality is bounded by whatever embedding
// model is in use, and the zero-config default (LocalTransformersEmbeddingProvider,
// a 384-dim MiniLM model) trades some of that quality for needing no setup
// at all; an API-backed embedding model, configured explicitly, will
// generally retrieve better.

export interface RetrievedChunk {
  text: string;
  /** Cosine similarity to the query — higher is a better match. */
  score: number;
  sourcePath: string;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  /** The source document's Markdown frontmatter (title, tags, ...), if any. */
  frontmatter?: Record<string, unknown>;
}

export interface RetrieveOptions {
  /** Max number of chunks to return. Default 8. */
  topK?: number;
  /**
   * Minimum cosine similarity a chunk must have to be included. Default 0 —
   * filters out only negative-similarity (anti-correlated) chunks, which are
   * never a genuine match. A stricter universal default isn't safe to pick
   * here: "relevant" cosine similarity varies by embedding model, so a fixed
   * threshold like 0.5 could silently hide real matches for one model while
   * letting noise through for another. Callers who know their embedding
   * model's score distribution should pass an explicit, higher minScore.
   */
  minScore?: number;
}

export interface IndexSummary {
  documentsIndexed: number;
  /** Documents whose content hash hadn't changed since the last index — skipped without re-embedding. */
  documentsSkipped: number;
  /** Documents that failed to load (unsupported/corrupt) or failed embedding/storage. */
  documentsFailed: number;
  chunksIndexed: number;
  failures: { path: string; reason: string }[];
}

const DEFAULT_TOP_K = 8;
const DEFAULT_MIN_SCORE = 0;

/**
 * Retrieves relevant chunks from a project's VectorStore. Must be
 * constructed with the SAME EmbeddingProvider instance/config used to index
 * the store's contents — mixing embedding models between indexing and
 * querying produces different vector dimensions (VectorStore.search detects
 * and throws on that) or, worse, same-dimension-but-different-space vectors
 * whose cosine similarity is meaningless without any error at all. There's
 * no way to detect the latter automatically, so this is a contract the
 * caller must uphold, not something this class can fully guard against.
 */
export class Retriever {
  private readonly vectorStore: VectorStore;

  constructor(
    cwd: string,
    private readonly provider: EmbeddingProvider,
  ) {
    this.vectorStore = new VectorStore(cwd);
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

    const [queryEmbedding] = await this.provider.embed([query]);
    if (!queryEmbedding) return [];

    const hits = this.vectorStore.search(queryEmbedding, topK);
    return hits
      .filter((hit) => hit.similarity >= minScore)
      .map((hit) => ({
        text: hit.text,
        score: hit.similarity,
        sourcePath: hit.sourcePath,
        chunkIndex: hit.chunkIndex,
        startOffset: hit.startOffset,
        endOffset: hit.endOffset,
        frontmatter: hit.frontmatter,
      }));
  }

  /**
   * Ties Phase 4 (document-loader) + Phase 5 (chunker/embedding-provider/
   * vector-store) together for the common "index this project" case. Skips
   * embedding entirely for documents whose content hash hasn't changed since
   * the last index — VectorStore.upsertDocument would also no-op on those,
   * but only after the (expensive) embedding work already happened; checking
   * listDocuments()'s hashes up front avoids paying that cost at all.
   */
  async indexProject(dirPath: string, options?: ChunkOptions): Promise<IndexSummary> {
    const { documents, skipped } = await loadDirectory(dirPath);
    const existingHashes = new Map(this.vectorStore.listDocuments().map((doc) => [doc.sourcePath, doc.contentHash]));

    const failures: { path: string; reason: string }[] = skipped.map((s) => ({ path: s.path, reason: s.reason }));
    let documentsIndexed = 0;
    let documentsSkipped = 0;
    let chunksIndexed = 0;

    for (const document of documents) {
      if (existingHashes.get(document.sourcePath) === document.contentHash) {
        documentsSkipped++;
        continue;
      }
      try {
        const chunks = chunkDocument(document, options);
        const embeddings = chunks.length > 0 ? await this.provider.embed(chunks.map((c) => c.text)) : [];
        this.vectorStore.upsertDocument(document, chunks, embeddings);
        documentsIndexed++;
        chunksIndexed += chunks.length;
      } catch (err) {
        failures.push({ path: document.sourcePath, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      documentsIndexed,
      documentsSkipped,
      documentsFailed: failures.length,
      chunksIndexed,
      failures,
    };
  }
}
