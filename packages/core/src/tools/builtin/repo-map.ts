import type { ToolDefinition } from "../../core/types.js";
import { buildRepoMap, formatRepoMap } from "./repo-map/build.js";

// Port of aider's repomap.py concept: a condensed map of the most
// important files/symbols in a repo, so a large codebase can be
// meaningfully navigated without loading everything into context. Real
// tree-sitter parsing (via web-tree-sitter + prebuilt WASM grammars, no
// native compilation) extracts each file's actual function/class/method/
// interface definitions — not a regex guess — for 7 languages (JS/TS/TSX,
// Python, Go, Rust, Java; see repo-map/languages.ts). Files are ranked by
// PageRank over a cross-file "who references whom" graph, same algorithm
// aider uses (via networkx there, hand-rolled here — see
// repo-map/pagerank.ts), so files other code actually depends on surface
// above leaf files nobody imports.
//
// Scope reduction vs aider, disclosed: cross-file references are detected
// by a language-agnostic identifier-token scan of each file's raw source
// (does file A's text contain a name file B defines?), not per-language
// "reference" AST queries the way definitions are extracted. This misses
// some precision (a comment mentioning a name counts the same as a real
// call) and mid-size-identifier name collisions across unrelated files
// create some graph noise, but avoids maintaining a second query set per
// language on top of the definitions one — a reasonable tradeoff for a
// v1, revisit if the noise turns out to matter in practice.
interface RepoMapInput {
  focusFiles?: string[];
  maxChars?: number;
}

export const repoMapTool: ToolDefinition<RepoMapInput> = {
  name: "repo_map",
  description:
    "Get a condensed map of the repository's most important source files and their top-level definitions " +
    "(functions, classes, methods, interfaces), ranked by how much other code in the repo actually references " +
    "each file — real tree-sitter parsing, not a keyword guess. Use this to orient in a large or unfamiliar " +
    "codebase before diving into individual files with read_file/grep. Supports JS/TS/TSX/JSX, Python, Go, " +
    "Rust, and Java; other file types are silently excluded from the map (use glob/grep for those). Optionally " +
    "pass `focusFiles` (paths you're already looking at) to bias the ranking toward files related to them, and " +
    "`maxChars` to control how much of the map is returned (default 8000).",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      focusFiles: { type: "array", items: { type: "string" }, description: "Paths (relative to the project root) to bias the ranking toward, e.g. files you're currently editing" },
      maxChars: { type: "number", description: "Character budget for the returned map (default 8000)" },
    },
  },
  describeCall: (input) => (input.focusFiles?.length ? `repo map (focused on ${input.focusFiles.join(", ")})` : "repo map"),
  async handler(input, ctx) {
    try {
      const result = await buildRepoMap(ctx.cwd, { focusFiles: input.focusFiles, maxChars: input.maxChars });
      return { content: formatRepoMap(result), isError: false };
    } catch (err) {
      return { content: `Failed to build repo map: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
