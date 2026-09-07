import path from "node:path";
import { createRequire } from "node:module";
import { Parser, Language, Query } from "web-tree-sitter";
import { LANGUAGES, languageForFile } from "./languages.js";

const require = createRequire(import.meta.url);

let initialized: Promise<void> | undefined;
async function ensureInitialized(): Promise<void> {
  initialized ??= Parser.init();
  return initialized;
}

function wasmsDir(): string {
  return path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
}

const loadedLanguages = new Map<string, Promise<Language>>();
function loadLanguage(languageId: string): Promise<Language> {
  let promise = loadedLanguages.get(languageId);
  if (!promise) {
    const spec = LANGUAGES[languageId];
    if (!spec) throw new Error(`No tree-sitter grammar registered for language "${languageId}"`);
    promise = ensureInitialized().then(() => Language.load(path.join(wasmsDir(), spec.wasmFile)));
    loadedLanguages.set(languageId, promise);
  }
  return promise;
}

const compiledQueries = new Map<string, Query>();
async function getQuery(languageId: string): Promise<Query> {
  let query = compiledQueries.get(languageId);
  if (!query) {
    const spec = LANGUAGES[languageId]!;
    const language = await loadLanguage(languageId);
    query = new Query(language, spec.definitionsQuery);
    compiledQueries.set(languageId, query);
  }
  return query;
}

export interface Definition {
  name: string;
  /** e.g. "function", "class", "method", "interface" — from the query capture name's last segment. */
  kind: string;
  /** 0-indexed line, for a human-readable map. */
  line: number;
}

/** Parses one file's source and extracts its top-level/class-member definitions (functions, classes, methods, ...) via a real tree-sitter AST — not regex. Returns undefined for an unsupported extension. */
export async function extractDefinitions(filePath: string, source: string): Promise<Definition[] | undefined> {
  const languageId = languageForFile(filePath);
  if (!languageId) return undefined;

  const language = await loadLanguage(languageId);
  const query = await getQuery(languageId);
  const parser = new Parser();
  parser.setLanguage(language);

  let tree;
  try {
    tree = parser.parse(source);
  } catch {
    return undefined; // a genuinely unparseable file (encoding issue, truncated, etc.) contributes nothing rather than aborting the whole map
  }
  if (!tree) return undefined;

  const definitions: Definition[] = [];
  for (const match of query.matches(tree.rootNode)) {
    for (const capture of match.captures) {
      const kind = capture.name.split(".").pop();
      if (!kind) continue;
      definitions.push({ name: capture.node.text, kind, line: capture.node.startPosition.row });
    }
  }
  return definitions;
}
