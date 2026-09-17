import type { ToolDefinition } from "./types.js";

// Real, measured problem this closes: sending every registered tool's
// full schema (name+description+JSON schema) on every single turn scales
// the prefill cost with the TOTAL number of tools available, not the
// number actually relevant to the current task — confirmed directly: a
// small local model (1.4B, MLX) took 277s (and an earlier, larger local
// model attempt never finished after 2 minutes) to even start answering
// with this project's full ~180-tool list in the request, vs 3-5s with a
// handful. A comparable project's own answer to this (verified against
// its real source/docs, not guessed) is "Tool Search": defer full tool
// schemas behind a small, fixed set of meta-tools (search/describe/call)
// that the model uses to find and invoke the ONE real tool it actually
// needs, so the per-turn request stays small regardless of how many
// tools this project has registered in total. This module is that
// mechanism's core — session/loop wiring (including call_tool's dispatch,
// which must still go through the exact same permission/risk-level
// checks a direct call would) lives in loop.ts, not here.
export const SEARCH_TOOLS_NAME = "search_tools";
export const DESCRIBE_TOOL_NAME = "describe_tool";
export const CALL_TOOL_NAME = "call_tool";

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

// A real BM25 ranking (the same scoring SQLite's own bm25(), already used
// elsewhere in this project for session search, implements) over each
// tool's name+description — not a naive substring/keyword-count match.
// Reimplemented by hand rather than reusing session-search-index.ts's
// SQLite-backed index: that index is file-backed and incremental (built
// for thousands of session messages that change over time); a tool list
// is small (a few hundred at most) and effectively static for a session's
// lifetime, so scoring it fresh in memory on every search_tools call is
// simpler and cheap enough not to need persistence or incremental
// indexing at all.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export interface ToolSearchHit {
  tool: ToolDefinition;
  score: number;
}

/** Ranks `tools` by real BM25 relevance to `query` over each tool's name+description — returns only tools with a nonzero score (an honest "nothing matched", not a random top-N fallback), best match first. */
export function rankToolsByQuery(tools: ToolDefinition[], query: string, limit = DEFAULT_SEARCH_LIMIT): ToolSearchHit[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || tools.length === 0) return [];

  const docs = tools.map((tool) => tokenize(`${tool.name} ${tool.description}`));
  const avgDocLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;

  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const scored: ToolSearchHit[] = tools.map((tool, i) => {
    const doc = docs[i]!;
    const termFrequency = new Map<string, number>();
    for (const term of doc) termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);

    let score = 0;
    for (const term of queryTerms) {
      const tf = termFrequency.get(term) ?? 0;
      if (tf === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (tools.length - df + 0.5) / (df + 0.5));
      const norm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgDocLength)));
      score += idf * norm;
    }
    return { tool, score };
  });

  return scored
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limit, MAX_SEARCH_LIMIT));
}

/**
 * The two safe, read-only meta-tools a Tool-Search-enabled session sends
 * instead of (most of) its real tool list — `getAvailableTools` is a live
 * getter (not a fixed snapshot) so it reflects whatever the session's own
 * disabledTools/disabledMcpServers filtering currently allows, same as a
 * direct call would see. `call_tool` deliberately isn't built here as a
 * third generic pass-through tool: dispatching it by directly invoking
 * the target tool's own handler would skip the permission-manager/hook/
 * risk-level check a direct call to that tool normally goes through — see
 * loop.ts, which intercepts CALL_TOOL_NAME before the permission check
 * and remaps it onto the real target tool, so every safety check that
 * would apply to calling it directly still applies exactly the same way.
 */
export function createToolSearchMetaTools(getAvailableTools: () => ToolDefinition[]): ToolDefinition[] {
  const searchTools: ToolDefinition<{ query: string; limit?: number }> = {
    name: SEARCH_TOOLS_NAME,
    description:
      "Find which of this project's tools can do what you need — most tools are NOT sent to you directly " +
      "(there are too many to list every turn), so start here instead of guessing a name. Returns up to " +
      `${DEFAULT_SEARCH_LIMIT} matching tool names with a one-line description, ranked by relevance. Follow ` +
      `up with ${DESCRIBE_TOOL_NAME} for a match's full input schema, then ${CALL_TOOL_NAME} to actually run it.`,
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'What you need to do, e.g. "run a shell command" or "search the web"' },
        limit: { type: "number", description: `Max results (default ${DEFAULT_SEARCH_LIMIT}, capped at ${MAX_SEARCH_LIMIT})` },
      },
      required: ["query"],
    },
    describeCall: (input) => `search tools matching "${input.query}"`,
    async handler(input) {
      const hits = rankToolsByQuery(getAvailableTools(), input.query, input.limit ?? DEFAULT_SEARCH_LIMIT);
      if (hits.length === 0) return { content: `No tool matched "${input.query}" — try broader or different terms.`, isError: false };
      return { content: hits.map((h) => `- ${h.tool.name}: ${h.tool.description}`).join("\n"), isError: false };
    },
  };

  const describeTool: ToolDefinition<{ name: string }> = {
    name: DESCRIBE_TOOL_NAME,
    description: `Get a tool's full input schema and risk level by name (from ${SEARCH_TOOLS_NAME}'s results) before calling it via ${CALL_TOOL_NAME}.`,
    riskLevel: "safe",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    describeCall: (input) => `describe tool "${input.name}"`,
    async handler(input) {
      const tool = getAvailableTools().find((t) => t.name === input.name);
      if (!tool) return { content: `No tool named "${input.name}" available right now — use ${SEARCH_TOOLS_NAME} to find the right name.`, isError: true };
      return {
        content: JSON.stringify({ name: tool.name, description: tool.description, riskLevel: tool.riskLevel, inputSchema: tool.inputSchema }, null, 2),
        isError: false,
      };
    },
  };

  return [searchTools, describeTool];
}

/** The `call_tool` tool definition advertised to the model — its own `handler` is never actually invoked (loop.ts intercepts CALL_TOOL_NAME before dispatch and remaps onto the real target tool instead); this only exists so its schema gets sent alongside search_tools/describe_tool. Throws if somehow called directly, so a bug in that interception shows up loudly instead of silently no-op'ing. */
export function createCallToolMetaTool(): ToolDefinition<{ name: string; input?: Record<string, unknown> }> {
  return {
    name: CALL_TOOL_NAME,
    description: `Actually run a tool found via ${SEARCH_TOOLS_NAME}/${DESCRIBE_TOOL_NAME}, by its real name and input.`,
    riskLevel: "safe", // the REAL target tool's own riskLevel is what actually gates confirmation — see loop.ts's interception
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: `The real tool's name, from ${SEARCH_TOOLS_NAME}` },
        input: { type: "object", description: `That tool's own input, matching the schema ${DESCRIBE_TOOL_NAME} returned` },
      },
      required: ["name"],
    },
    describeCall: (input) => `call tool "${input.name}"`,
    async handler() {
      throw new Error(`${CALL_TOOL_NAME} must be intercepted by the agent loop before its handler ever runs — see toolsForProvider/runOneToolCall in loop.ts.`);
    },
  };
}
