import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { sessionDir, sessionsRoot, type SessionFile } from "../../core/session.js";

// Cross-session recall, inspired by Hermes Agent's own "searches its own
// past conversations" feature: this project already persists every
// session's full message history to disk (core/session.ts, one JSON file
// per session under ~/.finanfa-code/sessions/<project-hash>/), but had no
// way to search across that history — only /resume + /continue by exact
// session id. This adds keyword search over past sessions' actual
// conversation content (user/assistant text; tool-call/tool-result
// messages are skipped — noisy, and usually not what "what did we decide
// about X" recall is after).
//
// Disclosed scope reduction vs Hermes Agent's real FTS5 index: this scans
// session JSON files directly (bounded to the MAX_SESSIONS_SCANNED most
// recently modified) rather than maintaining a persistent full-text
// index — no new dependency (sqlite3/FTS5 needs native compilation), and
// a typical user's session count makes a live scan genuinely fast enough;
// revisit with a real index if session volume ever makes this slow.
const MAX_SESSIONS_SCANNED = 500;
const MAX_EXCERPTS_PER_SESSION = 2;
const EXCERPT_CONTEXT_CHARS = 200;

interface ScoredExcerpt {
  role: "user" | "assistant";
  text: string;
  score: number;
}

interface ScoredSession {
  id: string;
  cwd: string;
  title?: string;
  mtimeMs: number;
  score: number;
  excerpts: ScoredExcerpt[];
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length > 1))];
}

function scoreText(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

function excerptAround(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const firstMatchIndex = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstMatchIndex - EXCERPT_CONTEXT_CHARS / 2);
  const end = Math.min(text.length, start + EXCERPT_CONTEXT_CHARS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

async function listSessionFiles(scope: "project" | "all", cwd: string): Promise<{ filePath: string; mtimeMs: number }[]> {
  const dirs: string[] = [];
  if (scope === "project") {
    dirs.push(sessionDir(cwd));
  } else {
    try {
      const projectDirs = await readdir(sessionsRoot());
      for (const projectDir of projectDirs) dirs.push(path.join(sessionsRoot(), projectDir));
    } catch {
      return [];
    }
  }

  const files: { filePath: string; mtimeMs: number }[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      files.push({ filePath: path.join(dir, entry), mtimeMs: 0 });
    }
  }
  return files;
}

async function searchSessions(cwd: string, query: string, scope: "project" | "all", maxResults: number): Promise<ScoredSession[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const files = await listSessionFiles(scope, cwd);

  // Most-recently-modified first, so a bounded scan still favors recent
  // (more likely relevant) sessions over ancient ones when there are more
  // sessions on disk than MAX_SESSIONS_SCANNED.
  const withStats = await Promise.all(
    files.map(async (f) => {
      try {
        const st = await stat(f.filePath);
        return { ...f, mtimeMs: st.mtimeMs };
      } catch {
        return f;
      }
    }),
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const candidates = withStats.slice(0, MAX_SESSIONS_SCANNED);

  const scored: ScoredSession[] = [];
  for (const { filePath, mtimeMs } of candidates) {
    let data: SessionFile;
    try {
      data = JSON.parse(await readFile(filePath, "utf-8")) as SessionFile;
    } catch {
      continue;
    }

    const excerpts: ScoredExcerpt[] = [];
    let sessionScore = 0;
    for (const message of data.messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = message.content;
      if (!text) continue;
      const score = scoreText(text, terms);
      if (score === 0) continue;
      sessionScore += score;
      excerpts.push({ role: message.role, text: excerptAround(text, terms), score });
    }
    if (sessionScore === 0) continue;

    excerpts.sort((a, b) => b.score - a.score);
    scored.push({ id: data.id, cwd: data.cwd, title: data.title, mtimeMs, score: sessionScore, excerpts: excerpts.slice(0, MAX_EXCERPTS_PER_SESSION) });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

function formatResults(sessions: ScoredSession[], scope: "project" | "all"): string {
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
    "user/assistant message text from persisted session history; returns matching sessions with a short " +
    "excerpt around the match, ranked by how many query terms matched. Use /resume <session id> to actually " +
    "reopen a matched session.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords to search for (space-separated; matches are case-insensitive substrings)" },
      scope: { type: "string", enum: ["project", "all"], description: "'project' (default) searches only this project's sessions; 'all' searches every project" },
      maxResults: { type: "number", description: "Maximum number of sessions to return (default 5)" },
    },
    required: ["query"],
  },
  describeCall: (input) => `recall past sessions matching "${input.query}"${input.scope === "all" ? " (all projects)" : ""}`,
  async handler(input, ctx) {
    const scope = input.scope ?? "project";
    const results = await searchSessions(ctx.cwd, input.query, scope, input.maxResults ?? 5);
    return { content: formatResults(results, scope), isError: false };
  },
};
