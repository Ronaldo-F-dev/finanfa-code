import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { extractDefinitions, type Definition } from "./parser.js";
import { personalizedPageRank, type WeightedEdge } from "./pagerank.js";
import { SUPPORTED_GLOB_PATTERNS } from "./languages.js";

const DEFAULT_MAX_CHARS = 8_000;
const MAX_FILES_TO_PARSE = 2_000;
const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

export interface RepoMapOptions {
  /** Files the caller is already focused on — get a personalization boost in the PageRank, same idea as aider's "chat files" (the neighbors of what you're already looking at rank higher too, not just the files themselves). */
  focusFiles?: string[];
  maxChars?: number;
}

export interface RepoMapFileEntry {
  file: string;
  rank: number;
  definitions: Definition[];
}

export interface RepoMapResult {
  entries: RepoMapFileEntry[];
  filesScanned: number;
  filesParsed: number;
  truncated: boolean;
}

/** Extracts every identifier-shaped token from raw source, language-agnostically (a simplification vs per-language "reference" AST queries — see repo-map.ts's description for why this is an honest, disclosed scope choice rather than an oversight). */
function tokenize(source: string): Set<string> {
  return new Set(source.match(IDENTIFIER_RE) ?? []);
}

export async function buildRepoMap(cwd: string, options: RepoMapOptions = {}): Promise<RepoMapResult> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const allFiles = await fg(SUPPORTED_GLOB_PATTERNS, {
    cwd,
    dot: false,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**", "**/out/**", "**/vendor/**"],
    onlyFiles: true,
  });
  const files = allFiles.slice(0, MAX_FILES_TO_PARSE).sort();

  const definitionsByFile = new Map<string, Definition[]>();
  const tokensByFile = new Map<string, Set<string>>();

  for (const file of files) {
    let source: string;
    try {
      source = await readFile(path.join(cwd, file), "utf-8");
    } catch {
      continue;
    }
    const definitions = await extractDefinitions(file, source);
    if (!definitions) continue; // unsupported extension for this file (shouldn't happen given the glob, but a file that fails to read/parse falls through here too)
    definitionsByFile.set(file, definitions);
    tokensByFile.set(file, tokenize(source));
  }

  const parsedFiles = [...definitionsByFile.keys()];

  // Which file(s) define a given symbol name — used to build cross-file edges below.
  const symbolOwners = new Map<string, Set<string>>();
  for (const [file, definitions] of definitionsByFile) {
    for (const def of definitions) {
      let owners = symbolOwners.get(def.name);
      if (!owners) {
        owners = new Set();
        symbolOwners.set(def.name, owners);
      }
      owners.add(file);
    }
  }

  const edges: WeightedEdge[] = [];
  for (const [file, tokens] of tokensByFile) {
    const weightByTarget = new Map<string, number>();
    for (const token of tokens) {
      const owners = symbolOwners.get(token);
      if (!owners) continue;
      for (const owner of owners) {
        if (owner === file) continue;
        weightByTarget.set(owner, (weightByTarget.get(owner) ?? 0) + 1);
      }
    }
    for (const [to, weight] of weightByTarget) edges.push({ from: file, to, weight });
  }

  const personalization = options.focusFiles && options.focusFiles.length > 0 ? new Map(options.focusFiles.filter((f) => definitionsByFile.has(f)).map((f) => [f, 1])) : undefined;

  const ranks = personalizedPageRank(parsedFiles, edges, personalization);
  const rankedFiles = parsedFiles.sort((a, b) => (ranks.get(b) ?? 0) - (ranks.get(a) ?? 0));

  const entries: RepoMapFileEntry[] = [];
  let usedChars = 0;
  let truncated = false;
  for (const file of rankedFiles) {
    const definitions = definitionsByFile.get(file)!;
    const entryChars = file.length + definitions.reduce((sum, d) => sum + d.kind.length + d.name.length + 10, 20);
    if (usedChars + entryChars > maxChars && entries.length > 0) {
      truncated = true;
      break;
    }
    usedChars += entryChars;
    entries.push({ file, rank: ranks.get(file) ?? 0, definitions });
  }

  return { entries, filesScanned: files.length, filesParsed: parsedFiles.length, truncated };
}

export function formatRepoMap(result: RepoMapResult): string {
  if (result.entries.length === 0) {
    return `No source files in a supported language (JS/TS/TSX, Python, Go, Rust, Java) were found among the ${result.filesScanned} file(s) scanned.`;
  }

  const lines: string[] = [`Repo map: ${result.filesParsed} source file(s) parsed, ranked by PageRank over a cross-file symbol-reference graph. Showing top ${result.entries.length}.`, ""];
  for (const entry of result.entries) {
    lines.push(entry.file);
    const byLine = [...entry.definitions].sort((a, b) => a.line - b.line);
    for (const def of byLine) lines.push(`  ${def.kind} ${def.name}  (line ${def.line + 1})`);
    lines.push("");
  }
  if (result.truncated) lines.push(`... (truncated to fit the character budget; ${result.filesParsed - result.entries.length} lower-ranked file(s) omitted)`);
  return lines.join("\n").trimEnd();
}
