import type * as NodeSqlite from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { cosineSimilarity } from "../embeddings.js";
import type { LoadedDocument } from "./document-loader.js";
import type { DocumentChunk } from "./chunker.js";

// Loaded via process.getBuiltinModule, same reasoning as
// memory-search-index.ts/session-search-index.ts's own identical line —
// this repo's toolchain doesn't yet recognize node:sqlite as a static
// import target.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof NodeSqlite;

// Phase 5's VectorStore: the same cache-by-content-hash SQLite pattern
// memory-search-index.ts/session-search-index.ts already use for their own
// embedding caches, generalized to arbitrary document chunks (Phase 4's
// DocumentChunk) instead of memory notes or session messages. Scoped
// per-project (<cwd>/.finanfa-code/rag-index.sqlite), matching how
// scoped-instructions.ts/claw-bundle.ts already keep project-specific state
// under the project's own .finanfa-code/ directory, rather than the
// per-user ~/.finanfa-code/ that memory/session search use (a document
// corpus is naturally project-scoped, not global to the user).

function indexFilePath(cwd: string): string {
  return path.join(cwd, ".finanfa-code", "rag-index.sqlite");
}

const openDbs = new Map<string, NodeSqlite.DatabaseSync>();

function getDb(cwd: string): NodeSqlite.DatabaseSync {
  const filePath = indexFilePath(cwd);
  const existing = openDbs.get(filePath);
  if (existing) return existing;

  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      source_path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      source_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      text TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      embedding_json TEXT NOT NULL,
      PRIMARY KEY (source_path, chunk_index)
    );
  `);
  // Phase 6 addition: a document's Markdown frontmatter (title, tags, ...)
  // wasn't persisted by Phase 5 at all, but Retriever needs it to hand back
  // on every chunk. Added as a migration (not baked into the CREATE TABLE
  // above) so a rag-index.sqlite file created by Phase 5 still opens.
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN frontmatter_json TEXT;`);
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column name/i.test(err.message)) throw err;
  }
  openDbs.set(filePath, db);
  return db;
}

/** Test-only: closes and drops every cached handle so a fresh call re-opens (a new temp cwd in a test needs a fresh database file, not a previous test's cached connection). */
export function resetVectorStoreForTests(): void {
  for (const db of openDbs.values()) db.close();
  openDbs.clear();
}

export interface VectorSearchHit {
  sourcePath: string;
  chunkIndex: number;
  text: string;
  startOffset: number;
  endOffset: number;
  /** Cosine similarity to the query — higher is a better match. */
  similarity: number;
  /** The source document's Markdown frontmatter (title, tags, ...), if any was recorded at index time. */
  frontmatter?: Record<string, unknown>;
}

export interface VectorStoreDocument {
  sourcePath: string;
  contentHash: string;
  chunkCount: number;
}

/**
 * Per-project store of document chunks + their embeddings, backed by
 * SQLite (node:sqlite, same binding memory/session search already use —
 * no second SQLite dependency).
 */
export class VectorStore {
  private readonly db: NodeSqlite.DatabaseSync;

  constructor(cwd: string) {
    this.db = getDb(cwd);
  }

  /**
   * Replaces this document's chunks with the given ones. If the document's
   * content hash is unchanged from what's already stored, this is a no-op
   * (nothing to invalidate, nothing to re-embed) — callers still pay for
   * the caller-side embedding, so checking here mainly matters if the
   * caller re-embeds unconditionally; still, upsertDocument's own contract
   * is idempotent-per-hash. If the hash changed (or the document is new),
   * all of the document's prior chunk rows are deleted and replaced with
   * `chunks`/`embeddings` — a document that shrank (fewer chunks than
   * before) doesn't leave stale trailing rows behind.
   */
  upsertDocument(document: LoadedDocument, chunks: DocumentChunk[], embeddings: number[][]): void {
    if (chunks.length !== embeddings.length) {
      throw new Error(`chunks (${chunks.length}) and embeddings (${embeddings.length}) length mismatch`);
    }

    const existing = this.db.prepare("SELECT content_hash FROM documents WHERE source_path = ?").get(document.sourcePath) as
      | { content_hash: string }
      | undefined;
    if (existing && existing.content_hash === document.contentHash) return; // unchanged — nothing to invalidate or re-embed

    const deleteChunks = this.db.prepare("DELETE FROM chunks WHERE source_path = ?");
    const upsertDoc = this.db.prepare(
      "INSERT OR REPLACE INTO documents (source_path, content_hash, frontmatter_json) VALUES (?, ?, ?)",
    );
    const insertChunk = this.db.prepare(
      "INSERT OR REPLACE INTO chunks (source_path, chunk_index, content_hash, text, start_offset, end_offset, embedding_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );

    deleteChunks.run(document.sourcePath);
    upsertDoc.run(document.sourcePath, document.contentHash, document.frontmatter ? JSON.stringify(document.frontmatter) : null);
    chunks.forEach((chunk, i) => {
      insertChunk.run(
        document.sourcePath,
        chunk.chunkIndex,
        chunk.documentContentHash,
        chunk.text,
        chunk.startOffset,
        chunk.endOffset,
        JSON.stringify(embeddings[i]),
      );
    });
  }

  /** Removes a document and all of its chunks. A no-op if the source path isn't stored. */
  removeDocument(sourcePath: string): void {
    this.db.prepare("DELETE FROM chunks WHERE source_path = ?").run(sourcePath);
    this.db.prepare("DELETE FROM documents WHERE source_path = ?").run(sourcePath);
  }

  /** Every stored document's source path, content hash, and current chunk count. */
  listDocuments(): VectorStoreDocument[] {
    const rows = this.db
      .prepare(
        `SELECT d.source_path as sourcePath, d.content_hash as contentHash, COUNT(c.chunk_index) as chunkCount
         FROM documents d LEFT JOIN chunks c ON c.source_path = d.source_path
         GROUP BY d.source_path`,
      )
      .all() as unknown as VectorStoreDocument[];
    return rows;
  }

  /**
   * Ranks every stored chunk against `queryEmbedding` by cosine similarity,
   * highest first. Throws if a stored embedding's dimensionality doesn't
   * match `queryEmbedding`'s — this happens when a user switches embedding
   * provider/model after already indexing documents with a different one.
   * Cosine similarity between vectors of different lengths is meaningless
   * (or throws deep inside the math, depending on which is longer/shorter),
   * so this is caught up front with a message that tells the caller what
   * actually happened, rather than surfacing as a confusing NaN/undefined
   * downstream or a silently-wrong ranking.
   */
  search(queryEmbedding: number[], topK: number): VectorSearchHit[] {
    const rows = this.db
      .prepare(
        `SELECT c.source_path as sourcePath, c.chunk_index as chunkIndex, c.text as text,
                c.start_offset as startOffset, c.end_offset as endOffset, c.embedding_json as embeddingJson,
                d.frontmatter_json as frontmatterJson
         FROM chunks c JOIN documents d ON d.source_path = c.source_path`,
      )
      .all() as {
      sourcePath: string;
      chunkIndex: number;
      text: string;
      startOffset: number;
      endOffset: number;
      embeddingJson: string;
      frontmatterJson: string | null;
    }[];

    const scored: VectorSearchHit[] = rows.map((row) => {
      const embedding = JSON.parse(row.embeddingJson) as number[];
      if (embedding.length !== queryEmbedding.length) {
        throw new Error(
          `Embedding dimension mismatch: query embedding has ${queryEmbedding.length} dimensions but the stored chunk ` +
            `at ${row.sourcePath} (chunk ${row.chunkIndex}) has ${embedding.length}. This usually means the embedding ` +
            `provider/model changed since this project was indexed, re-run indexing with the current provider to fix it.`,
        );
      }
      return {
        sourcePath: row.sourcePath,
        chunkIndex: row.chunkIndex,
        text: row.text,
        startOffset: row.startOffset,
        endOffset: row.endOffset,
        similarity: cosineSimilarity(queryEmbedding, embedding),
        frontmatter: row.frontmatterJson ? (JSON.parse(row.frontmatterJson) as Record<string, unknown>) : undefined,
      };
    });
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }
}
