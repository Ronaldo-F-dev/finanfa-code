import type { ToolDefinition } from "../../core/types.js";
import { searchSessionIndex, searchSessionIndexBySimilarity, type SessionSearchHit } from "../../core/session-search-index.js";
import type { EmbeddingsConfig } from "../../core/embeddings.js";
import { wrapUntrustedContent } from "../../core/untrusted-content.js";

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

// A recalled excerpt is a past *user's* own message text, verbatim — the
// same injection risk as a fetched web page (see untrusted-content.ts):
// anything ever pasted or typed into an earlier session (a copied web
// page, an email, a file's contents) resurfaces here as this tool's
// output and would otherwise read as a fresh instruction. Doubly so for
// scope "all", which can recall text from a session belonging to an
// entirely different project than the one currently running.
function wrapRecalledContent(sessions: GroupedSession[], scope: "project" | "all"): string {
  const formatted = formatResults(sessions, scope);
  return sessions.length === 0 ? formatted : wrapUntrustedContent("recall_past_sessions", formatted);
}

interface RecallSessionsInput {
  query: string;
  scope?: "project" | "all";
  maxResults?: number;
  /** "keyword" (default): real FTS5 term matching. "semantic": embedding-based similarity — finds a conceptually related match with no shared keywords, at the cost of a real OpenAI embeddings call; only available when OPENAI_API_KEY is configured. */
  mode?: "keyword" | "semantic";
}

export function createRecallSessionsTool(embeddingsConfig: EmbeddingsConfig | undefined, embeddingsApiBaseUrl?: string): ToolDefinition<RecallSessionsInput> {
  return {
    name: "recall_past_sessions",
    description:
      "Search past conversation sessions (this project's, or across all projects) to recall what was discussed " +
      "or decided earlier without the user having to remember an exact session id. Returns matching sessions " +
      "with a short excerpt around the match, ranked by relevance. Use /resume <session id> to actually reopen " +
      'a matched session. mode "keyword" (default) does real full-text term matching. mode "semantic" finds a ' +
      "conceptually related match even with no shared keywords (e.g. \"login\" finding a message about JWT " +
      "tokens) via a real OpenAI embeddings call — needs OPENAI_API_KEY configured, and costs a real API call " +
      "each time, so prefer keyword mode unless it's genuinely come up empty on a query you're confident is in there.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords (keyword mode) or a natural-language description (semantic mode) to search for" },
        scope: { type: "string", enum: ["project", "all"], description: "'project' (default) searches only this project's sessions; 'all' searches every project" },
        maxResults: { type: "number", description: "Maximum number of sessions to return (default 5)" },
        mode: { type: "string", enum: ["keyword", "semantic"], description: 'Default "keyword"' },
      },
      required: ["query"],
    },
    describeCall: (input) =>
      `recall past sessions matching "${input.query}"${input.scope === "all" ? " (all projects)" : ""}${input.mode === "semantic" ? " (semantic)" : ""}`,
    async handler(input, ctx) {
      const scope = input.scope ?? "project";
      const maxResults = input.maxResults ?? 5;
      const mode = input.mode ?? "keyword";
      const terms = [...new Set(input.query.toLowerCase().split(/\s+/).filter((t) => t.length > 1))];

      if (mode === "semantic") {
        if (!embeddingsConfig) {
          return { content: "Semantic recall is not configured — set OPENAI_API_KEY as an environment variable, or use mode \"keyword\" instead.", isError: true };
        }
        const hits = await searchSessionIndexBySimilarity(
          input.query,
          scope === "project" ? ctx.cwd : undefined,
          maxResults,
          embeddingsConfig,
          embeddingsApiBaseUrl,
        );
        const sessions = groupBySession(hits, terms, maxResults);
        return { content: wrapRecalledContent(sessions, scope), isError: false };
      }

      const hits = await searchSessionIndex(input.query, scope === "project" ? ctx.cwd : undefined, maxResults);
      const sessions = groupBySession(hits, terms, maxResults);
      return { content: wrapRecalledContent(sessions, scope), isError: false };
    },
  };
}
