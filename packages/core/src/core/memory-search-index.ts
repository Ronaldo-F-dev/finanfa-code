import type * as NodeSqlite from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { embedTexts, cosineSimilarity, type EmbeddingsConfig } from "./embeddings.js";
import type { Memory } from "../memory/loader.js";

// Loaded via process.getBuiltinModule, same reasoning as
// session-search-index.ts's own identical line — this repo's toolchain
// doesn't yet recognize node:sqlite as a static import target.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof NodeSqlite;

// Semantic (embedding-based) search over saved memory notes — the same
// real capability recall_past_sessions already has over session
// history (session-search-index.ts), now also over memory/loader.ts's
// notes, which until now could only ever be found by their EXACT name
// (read_memory) or by scanning the whole index in the system prompt.
// Unlike sessions (thousands of messages, worth incrementally indexing
// by file mtime), memory notes are typically a handful to a few hundred
// — cheap enough to re-embed-check on every call — so the only thing
// actually worth persisting here is the embedding vectors themselves
// (a real, billed OpenAI API call per unique piece of content), keyed by
// a content hash exactly like session-search-index.ts's own
// message_embeddings table, not a from-scratch reimplementation of that
// caching idea.
function indexFilePath(): string {
  return path.join(os.homedir(), ".finanfa-code", "memory-embeddings.sqlite");
}

let db: NodeSqlite.DatabaseSync | undefined;

function getDb(): NodeSqlite.DatabaseSync {
  if (db) return db;
  // Unlike session-search-index.ts's sessionsRoot() (already created by
  // the time a session is persisted), ~/.finanfa-code/ itself has no
  // other reason to exist yet the first time memory search runs.
  mkdirSync(path.dirname(indexFilePath()), { recursive: true });
  db = new DatabaseSync(indexFilePath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      content_hash TEXT PRIMARY KEY,
      embedding_json TEXT NOT NULL
    );
  `);
  return db;
}

/** Test-only: closes and drops the cached handle so a fresh call re-opens (a new HOME env override in a test needs a fresh database file, not the previous test's cached connection). */
export function resetMemorySearchIndexForTests(): void {
  db?.close();
  db = undefined;
}

/** What actually gets embedded for a memory — description AND content, since a query like "how does the user like commits" should match a note whose one-line description says so even if the body itself uses different words. */
function embeddableText(memory: Memory): string {
  return `${memory.description}\n${memory.content}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Embeds every given memory's text not already cached, keyed by a hash of description+content — editing a note's content (or description) is a new hash, so it gets freshly embedded; an unchanged note never costs another real API call. */
export async function ensureMemoriesEmbedded(memories: Memory[], config: EmbeddingsConfig, apiBaseUrl?: string): Promise<void> {
  const database = getDb();
  const alreadyEmbedded = new Set(
    (database.prepare("SELECT content_hash FROM memory_embeddings").all() as { content_hash: string }[]).map((r) => r.content_hash),
  );

  const toEmbed = memories.map((m) => ({ memory: m, hash: hashContent(embeddableText(m)) })).filter((e) => !alreadyEmbedded.has(e.hash));
  if (toEmbed.length === 0) return;

  const vectors = await embedTexts(config, toEmbed.map((e) => embeddableText(e.memory)), apiBaseUrl);
  const insert = database.prepare("INSERT OR REPLACE INTO memory_embeddings (content_hash, embedding_json) VALUES (?, ?)");
  toEmbed.forEach((e, i) => insert.run(e.hash, JSON.stringify(vectors[i])));
}

export interface MemorySearchHit {
  memory: Memory;
  /** Cosine similarity to the query — higher is a better match (unlike session-search-index.ts's bm25-derived rank, there's no pre-existing "more negative is better" convention to stay consistent with here, so this reads the natural way). */
  similarity: number;
}

/** Semantic search over `memories` (typically loadMemories(cwd)'s own result) — embeds the query and every not-yet-cached memory, then ranks by cosine similarity. Finds a conceptually related note even with no shared keywords (e.g. "how does the user like to review PRs" matching a memory about atomic commits with neither word in common). */
export async function searchMemoriesBySimilarity(
  memories: Memory[],
  query: string,
  maxResults: number,
  config: EmbeddingsConfig,
  apiBaseUrl?: string,
): Promise<MemorySearchHit[]> {
  await ensureMemoriesEmbedded(memories, config, apiBaseUrl);
  const database = getDb();

  const [queryVector] = await embedTexts(config, [query], apiBaseUrl);
  const rows = database.prepare("SELECT content_hash, embedding_json FROM memory_embeddings").all() as {
    content_hash: string;
    embedding_json: string;
  }[];
  const embeddingByHash = new Map(rows.map((r) => [r.content_hash, JSON.parse(r.embedding_json) as number[]]));

  const scored: MemorySearchHit[] = [];
  for (const memory of memories) {
    const vector = embeddingByHash.get(hashContent(embeddableText(memory)));
    if (!vector) continue;
    scored.push({ memory, similarity: cosineSimilarity(queryVector!, vector) });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, maxResults);
}

/** Real (if simple) keyword search over the same corpus, for when semantic search isn't configured (no OPENAI_API_KEY) or isn't worth a real API call — scores by how many distinct query terms appear in the name/description/content, not just a substring check, so a multi-word query rewards a note matching more of it. */
export function searchMemoriesByKeyword(memories: Memory[], query: string, maxResults: number): MemorySearchHit[] {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length > 1))];
  if (terms.length === 0) return [];

  const scored: MemorySearchHit[] = [];
  for (const memory of memories) {
    const haystack = `${memory.name}\n${memory.description}\n${memory.content}`.toLowerCase();
    const matched = terms.filter((t) => haystack.includes(t)).length;
    if (matched > 0) scored.push({ memory, similarity: matched / terms.length });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, maxResults);
}
