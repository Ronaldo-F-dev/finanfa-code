import type { ToolDefinition } from "../../core/types.js";
import { searchSessionIndex, type SessionSearchHit } from "../../core/session-search-index.js";

// Cross-session recall, inspired by Hermes Agent's own "searches its own
// past conversations" feature: this project already persists every
// session's full message history to disk (core/session.ts, one JSON file
// per session under ~/.finanfa-code/sessions/<project-hash>/), but had no
// way to search across that history — only /resume + /continue by exact
// session id. Searches real user/assistant message text (tool-call/
// tool-result messages are skipped — noisy, and usually not what "what
// did we decide about X" recall is after) via a real SQLite FTS5 index
// (core/session-search-index.ts) — genuinely fast at any session volume,
// since an unchanged session file is never re-read/re-parsed on a later
// call; only new/changed sessions get indexed.
const MAX_EXCERPTS_PER_SESSION = 2;
const EXCERPT_CONTEXT_CHARS = 200;

function excerptAround(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const firstMatchIndex = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstMatchIndex - EXCERPT_CONTEXT_CHARS / 2);
  const end = Math.min(text.length, start + EXCERPT_CONTEXT_CHARS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

interface GroupedSession {
  id: string;
  cwd: string;
  title?: string;
  mtimeMs: number;
  rank: number; // aggregate bm25 rank across this session's matching messages — more negative is a better match
  excerpts: { role: string; text: string; rank: number }[];
}

function groupBySession(hits: SessionSearchHit[], terms: string[], maxResults: number): GroupedSession[] {
  const bySessionId = new Map<string, GroupedSession>();
  for (const hit of hits) {
    let session = bySessionId.get(hit.sessionId);
    if (!session) {
      session = { id: hit.sessionId, cwd: hit.cwd, title: hit.title, mtimeMs: hit.mtimeMs, rank: 0, excerpts: [] };
      bySessionId.set(hit.sessionId, session);
    }
    session.rank += hit.rank;
    session.excerpts.push({ role: hit.role, text: excerptAround(hit.content, terms), rank: hit.rank });
  }

  const sessions = [...bySessionId.values()];
  sessions.sort((a, b) => a.rank - b.rank); // ascending: SQLite's bm25() ranks a better match more negative
  for (const s of sessions) {
    s.excerpts.sort((a, b) => a.rank - b.rank);
    s.excerpts = s.excerpts.slice(0, MAX_EXCERPTS_PER_SESSION);
  }
  return sessions.slice(0, maxResults);
}

function formatResults(sessions: GroupedSession[], scope: "project" | "all"): string {
  if (sessions.length === 0) return "No past session matched that query.";

  const lines: string[] = [`${sessions.length} matching past session(s) (${scope === "all" ? "across all projects" : "this project"}):`, ""];
  for (const s of sessions) {
    const when = s.mtimeMs > 0 ? new Date(s.mtimeMs).toISOString() : "unknown time";
    const titlePart = s.title ? ` — "${s.title}"` : "";
    const cwdPart = scope === "all" ? ` [${s.cwd}]` : "";
    lines.push(`session ${s.id}${titlePart} (${when})${cwdPart}`);
    for (const excerpt of s.excerpts) lines.push(`  ${excerpt.role}: ${excerpt.text}`);
    lines.push("");
  }
  lines.push("Use /resume <session id> to reopen one of these in this project's session history.");
  return lines.join("\n").trimEnd();
}

interface RecallSessionsInput {
  query: string;
  scope?: "project" | "all";
  maxResults?: number;
}

export const recallSessionsTool: ToolDefinition<RecallSessionsInput> = {
  name: "recall_past_sessions",
  description:
    "Search past conversation sessions (this project's, or across all projects) for keywords, to recall what " +
    "was discussed or decided earlier without the user having to remember an exact session id. Searches real " +
    "user/assistant message text from persisted session history via a real full-text index, returning " +
    "matching sessions with a short excerpt around the match, ranked by relevance. Use /resume <session id> " +
    "to actually reopen a matched session.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords to search for (space-separated; matches any of the terms, ranked by relevance)" },
      scope: { type: "string", enum: ["project", "all"], description: "'project' (default) searches only this project's sessions; 'all' searches every project" },
      maxResults: { type: "number", description: "Maximum number of sessions to return (default 5)" },
    },
    required: ["query"],
  },
  describeCall: (input) => `recall past sessions matching "${input.query}"${input.scope === "all" ? " (all projects)" : ""}`,
  async handler(input, ctx) {
    const scope = input.scope ?? "project";
    const maxResults = input.maxResults ?? 5;
    const terms = [...new Set(input.query.toLowerCase().split(/\s+/).filter((t) => t.length > 1))];
    const hits = await searchSessionIndex(input.query, scope === "project" ? ctx.cwd : undefined, maxResults);
    const sessions = groupBySession(hits, terms, maxResults);
    return { content: formatResults(sessions, scope), isError: false };
  },
};
