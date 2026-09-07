// Per-language tree-sitter setup for the repo-map tool: which grammar
// (bundled prebuilt WASM, from tree-sitter-wasms — no native compilation
// needed, unlike node bindings for tree-sitter itself) parses which file
// extension, and a query capturing "definition" nodes (functions, classes,
// methods, interfaces, structs/types) in that grammar's real AST node
// names — verified against real parsed source for every language below
// before writing this file, not guessed from memory of the grammars.
//
// Scoped to 7 of the ~30 languages aider's own repo-map supports (JS/TS/
// TSX/JSX, Python, Go, Rust, Java) — the most common for a modern
// polyglot repo. Adding another language means adding one entry here with
// its own verified query; the rest of the pipeline (parsing, graph,
// PageRank, formatting) is language-agnostic.
export interface LanguageSpec {
  /** Filename in tree-sitter-wasms' out/ directory. */
  wasmFile: string;
  /** Tree-sitter query source; every capture name must start with "name.definition.". */
  definitionsQuery: string;
}

const JS_TS_SHARED_DEFINITIONS = `
(function_declaration name: (identifier) @name.definition.function)
(method_definition name: (property_identifier) @name.definition.method)
`;

const TS_ONLY_DEFINITIONS = `
(interface_declaration name: (type_identifier) @name.definition.interface)
(type_alias_declaration name: (type_identifier) @name.definition.type)
`;

export const LANGUAGES: Record<string, LanguageSpec> = {
  javascript: {
    wasmFile: "tree-sitter-javascript.wasm",
    definitionsQuery: `${JS_TS_SHARED_DEFINITIONS}\n(class_declaration name: (identifier) @name.definition.class)`,
  },
  typescript: {
    wasmFile: "tree-sitter-typescript.wasm",
    definitionsQuery: `${JS_TS_SHARED_DEFINITIONS}\n${TS_ONLY_DEFINITIONS}\n(class_declaration name: (type_identifier) @name.definition.class)`,
  },
  tsx: {
    wasmFile: "tree-sitter-tsx.wasm",
    definitionsQuery: `${JS_TS_SHARED_DEFINITIONS}\n${TS_ONLY_DEFINITIONS}\n(class_declaration name: (type_identifier) @name.definition.class)`,
  },
  python: {
    wasmFile: "tree-sitter-python.wasm",
    definitionsQuery: `
(function_definition name: (identifier) @name.definition.function)
(class_definition name: (identifier) @name.definition.class)
`,
  },
  go: {
    wasmFile: "tree-sitter-go.wasm",
    definitionsQuery: `
(function_declaration name: (identifier) @name.definition.function)
(method_declaration name: (field_identifier) @name.definition.method)
(type_spec name: (type_identifier) @name.definition.type)
`,
  },
  rust: {
    wasmFile: "tree-sitter-rust.wasm",
    definitionsQuery: `
(function_item name: (identifier) @name.definition.function)
(struct_item name: (type_identifier) @name.definition.struct)
(enum_item name: (type_identifier) @name.definition.enum)
(trait_item name: (type_identifier) @name.definition.trait)
`,
  },
  java: {
    wasmFile: "tree-sitter-java.wasm",
    definitionsQuery: `
(class_declaration name: (identifier) @name.definition.class)
(method_declaration name: (identifier) @name.definition.method)
(interface_declaration name: (identifier) @name.definition.interface)
`,
  },
};

const EXTENSION_TO_LANGUAGE: Record<string, keyof typeof LANGUAGES> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
};

export function languageForFile(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return undefined;
  return EXTENSION_TO_LANGUAGE[filePath.slice(dot).toLowerCase()];
}

export const SUPPORTED_GLOB_PATTERNS = Object.keys(EXTENSION_TO_LANGUAGE).map((ext) => `**/*${ext}`);
