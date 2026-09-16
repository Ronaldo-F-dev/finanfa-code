import type * as NodeSqlite from "node:sqlite";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { sessionsRoot, type SessionFile } from "./session.js";
import { embedTexts, cosineSimilarity, type EmbeddingsConfig } from "./embeddings.js";

// Loaded via process.getBuiltinModule (Node 22.3+) rather than a static
// `import ... from "node:sqlite"` — this repo's vite/vitest toolchain
// doesn't yet recognize this newer builtin in its externalization list
// and tries to actually resolve/bundle it, which fails outright. Runtime
// lookup sidesteps that entirely; only the type import above is static.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof NodeSqlite;

// A real SQLite FTS5 full-text index over every session's message
// history, replacing recall_past_sessions' original keyword-scan (which
// re-read and JSON-parsed every session file on every single call —
// fine at a handful of sessions, genuinely slow at hundreds/thousands).
// Uses Node's own built-in node:sqlite (stable enough for this; no new
// npm dependency, no native module to compile — matches this project's
// general dependency-conscious approach) rather than better-sqlite3.
//
// Incremental: each session file's mtime is tracked, and only a file
// that's new or changed since it was last indexed gets re-read/re-parsed
// — an unchanged session costs nothing on a later call. The real
// full-text query itself (ranking, multi-term OR-matching) is handled by
// SQLite's own bm25() ranking, not hand-rolled term-counting.
function indexFilePath(): string {
  return path.join(sessionsRoot(), "search-index.sqlite");
}

let db: NodeSqlite.DatabaseSync | undefined;

function getDb(): NodeSqlite.DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(indexFilePath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexed_sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      title TEXT,
      mtime_ms REAL NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      session_id UNINDEXED,
      role UNINDEXED,
      content
    );
    CREATE TABLE IF NOT EXISTS message_embeddings (
      content_hash TEXT PRIMARY KEY,
      embedding_json TEXT NOT NULL
    );
  `);
  return db;
}

/** Test-only: closes and drops the cached handle so a fresh call re-opens (a new HOME env override in a test needs a fresh database file, not the previous test's cached connection). */
export function resetSessionSearchIndexForTests(): void {
  db?.close();
  db = undefined;
}

async function listSessionFilesAcrossProjects(): Promise<string[]> {
  const files: string[] = [];
  let projectDirs: string[];
  try {
    projectDirs = await readdir(sessionsRoot());
  } catch {
    return [];
  }
  for (const projectDir of projectDirs) {
    const dir = path.join(sessionsRoot(), projectDir);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".json")) files.push(path.join(dir, entry));
    }
  }
  return files;
}

/** Re-reads and re-indexes every session file that's new or changed since it was last indexed; a file whose mtime matches what's already indexed is skipped entirely — no read, no JSON parse. */
export async function refreshSessionSearchIndex(): Promise<void> {
  const database = getDb();
  const files = await listSessionFilesAcrossProjects();

  const getIndexedMtime = database.prepare("SELECT mtime_ms FROM indexed_sessions WHERE id = ?");
  const upsertSession = database.prepare("INSERT OR REPLACE INTO indexed_sessions (id, cwd, title, mtime_ms) VALUES (?, ?, ?, ?)");
  const deleteMessages = database.prepare("DELETE FROM messages_fts WHERE session_id = ?");
  const insertMessage = database.prepare("INSERT INTO messages_fts (session_id, role, content) VALUES (?, ?, ?)");

  for (const filePath of files) {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      continue;
    }
    const id = path.basename(filePath, ".json");
    const existing = getIndexedMtime.get(id) as { mtime_ms: number } | undefined;
    if (existing && existing.mtime_ms === mtimeMs) continue; // unchanged — skip the read/parse entirely

    let data: SessionFile;
    try {
      data = JSON.parse(await readFile(filePath, "utf-8")) as SessionFile;
    } catch {
      continue;
    }

    deleteMessages.run(id);
    for (const message of data.messages) {
      if ((message.role === "user" || message.role === "assistant") && message.content) {
        insertMessage.run(id, message.role, message.content);
      }
    }
    upsertSession.run(id, data.cwd, data.title ?? null, mtimeMs);
  }
}

export interface SessionSearchHit {
  sessionId: string;
  cwd: string;
  title?: string;
  mtimeMs: number;
  role: string;
  content: string;
  rank: number;
}

/** Builds an FTS5 MATCH query that matches ANY of the given terms (not all) — bm25() ranking then naturally favors a session matching more of them, same forgiving multi-term behavior the original keyword scan had. */
function buildMatchQuery(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export async function searchSessionIndex(query: string, scopeCwd: string | undefined, maxResults: number): Promise<SessionSearchHit[]> {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length > 1))];
  if (terms.length === 0) return [];

  await refreshSessionSearchIndex();
  const database = getDb();

  const rows = database
    .prepare(
      `SELECT s.id as sessionId, s.cwd as cwd, s.title as title, s.mtime_ms as mtimeMs, m.role as role, m.content as content, bm25(messages_fts) as rank
       FROM messages_fts m JOIN indexed_sessions s ON s.id = m.session_id
       WHERE messages_fts MATCH ? ${scopeCwd ? "AND s.cwd = ?" : ""}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...(scopeCwd ? [buildMatchQuery(terms), scopeCwd, maxResults * 5] : [buildMatchQuery(terms), maxResults * 5]));

  return rows as unknown as SessionSearchHit[];
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Embeds every indexed message not already in message_embeddings — keyed
 * by a hash of its own content, not any row id, so a session's own
 * indexed messages getting deleted-and-reinserted on its next edit (see
 * refreshSessionSearchIndex — a whole session's FTS rows are replaced
 * together, not diffed message-by-message) doesn't force re-embedding
 * content that hasn't actually changed. Real API calls only ever happen
 * for genuinely new message text; everything else stays a plain cache
 * hit, keyed off the JS Set built below.
 */
export async function ensureMessagesEmbedded(config: EmbeddingsConfig, apiBaseUrl?: string): Promise<void> {
  await refreshSessionSearchIndex();
  const database = getDb();

  const messages = database.prepare("SELECT DISTINCT content FROM messages_fts").all() as { content: string }[];
  const alreadyEmbedded = new Set(
    (database.prepare("SELECT content_hash FROM message_embeddings").all() as { content_hash: string }[]).map((r) => r.content_hash),
  );

  const toEmbed = messages.filter((m) => !alreadyEmbedded.has(hashContent(m.content)));
  if (toEmbed.length === 0) return;

  const vectors = await embedTexts(config, toEmbed.map((m) => m.content), apiBaseUrl);
  const insert = database.prepare("INSERT OR REPLACE INTO message_embeddings (content_hash, embedding_json) VALUES (?, ?)");
  toEmbed.forEach((m, i) => insert.run(hashContent(m.content), JSON.stringify(vectors[i])));
}

/**
 * Semantic counterpart to searchSessionIndex — same SessionSearchHit
 * shape and the same "more negative rank is a better match" convention
 * (recall-sessions.ts's groupBySession sorts on that regardless of which
 * search mode produced a hit), so cosine similarity is negated here
 * rather than exposing a second, incompatible ranking scale.
 */
export async function searchSessionIndexBySimilarity(
  query: string,
  scopeCwd: string | undefined,
  maxResults: number,
  config: EmbeddingsConfig,
  apiBaseUrl?: string,
): Promise<SessionSearchHit[]> {
  await ensureMessagesEmbedded(config, apiBaseUrl);
  const database = getDb();

  const [queryVector] = await embedTexts(config, [query], apiBaseUrl);

  const rows = database
    .prepare(
      `SELECT s.id as sessionId, s.cwd as cwd, s.title as title, s.mtime_ms as mtimeMs, m.role as role, m.content as content
       FROM messages_fts m JOIN indexed_sessions s ON s.id = m.session_id
       ${scopeCwd ? "WHERE s.cwd = ?" : ""}`,
    )
    .all(...(scopeCwd ? [scopeCwd] : [])) as Omit<SessionSearchHit, "rank">[];

  const embeddingRows = database.prepare("SELECT content_hash, embedding_json FROM message_embeddings").all() as {
    content_hash: string;
    embedding_json: string;
  }[];
  const embeddingByHash = new Map(embeddingRows.map((r) => [r.content_hash, JSON.parse(r.embedding_json) as number[]]));

  const scored: SessionSearchHit[] = [];
  for (const row of rows) {
    const vector = embeddingByHash.get(hashContent(row.content));
    if (!vector) continue;
    scored.push({ ...row, rank: -cosineSimilarity(queryVector!, vector) });
  }

  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, maxResults * 5); // same generous multiplier as searchSessionIndex, before groupBySession's own per-session grouping/truncation
}
