// esbuild bundles the whole extension host to a single CJS file (see
// esbuild.config.mjs's own comment on why CJS, not ESM, for VS Code
// compatibility) — but `import.meta.url` is empty under the CJS output
// format (esbuild warns about this at build time), and @finanfa/core has a
// couple of real, module-top-level `createRequire(import.meta.url)` calls
// (packages/core/src/tools/builtin/query-database.ts, for node:sqlite;
// repo-map/parser.ts, for tree-sitter-wasms) that would otherwise crash the
// instant the bundle loads — not just when that specific tool is called.
//
// esbuild's `inject`+`define: {"import.meta.url": "importMetaUrl"}` (see
// esbuild.config.mjs) replaces every `import.meta.url` occurrence with this
// export. Since the whole extension collapses into one CJS module, every
// occurrence resolves to the SAME value (this bundle's own file path) —
// harmless for query-database.ts (createRequire("node:sqlite") is a Node
// builtin lookup, doesn't care about the base path at all), and accepted as
// a known Phase 1 limitation for repo-map/parser.ts's real path resolution
// (require.resolve("tree-sitter-wasms/...")) — see the plan's §3 on
// native/platform-specific tools not yet fully verified for this extension.
export const importMetaUrl = require("url").pathToFileURL(__filename).href;
