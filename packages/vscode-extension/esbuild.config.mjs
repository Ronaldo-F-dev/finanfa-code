import esbuild from "esbuild";

// @finanfa/core is workspace TS source, not a published npm package (no
// main/module/exports in its own package.json — see packages/cli/tsup.config.ts
// for the same situation) — it must be bundled here, unlike real npm deps.
// Those real deps are kept external (same list as tsup.config.ts's own
// external list) so esbuild doesn't try to also bundle their native/optional
// sub-dependencies (playwright-core, sharp, ...) — see the plan's §3 for why
// a VSIX handles this differently than the CLI's single-file bundle.
const external = [
  "vscode",
  "@anthropic-ai/sdk",
  "@modelcontextprotocol/sdk",
  "diff",
  "docx",
  "exceljs",
  "fast-glob",
  "gray-matter",
  "jszip",
  "mammoth",
  "marked",
  "mysql2",
  "pdf-lib",
  "pdf-parse",
  "pg",
  "playwright-core",
  // Real, activation-blocking bug found by test/bundle.test.ts: bundling
  // serialport's native-binding loader (@serialport/bindings-cpp) breaks
  // its own __dirname-relative prebuilt-binary discovery — the exact same
  // code works fine unbundled (as it already does in packages/core's own
  // test suite), so keeping it external (Node's real require resolves the
  // real, unmodified package at runtime) is the actual fix, not just a
  // smaller bundle.
  "serialport",
  "sharp",
  "word-extractor",
];

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  // CJS, not ESM: the VS Code extension host's `main` entry point has much
  // wider version compatibility as CommonJS — ESM extension entry points are
  // a newer, still-evolving capability. esbuild transpiles @finanfa/core's
  // own ESM source down to CJS during bundling regardless, so this doesn't
  // limit anything core-side.
  format: "cjs",
  target: "node18",
  outfile: "dist/extension.cjs",
  external,
  sourcemap: true,
  logLevel: "info",
  tsconfig: "../../tsconfig.json",
  // Real, activation-blocking bug this works around: @finanfa/core has a
  // couple of module-top-level `createRequire(import.meta.url)` calls
  // (query-database.ts, repo-map/parser.ts) — `import.meta.url` is empty
  // under esbuild's CJS output format, so createRequire(undefined) would
  // throw the instant the bundle loads, not just when those specific tools
  // run. See import-meta-url-shim.js for the full reasoning.
  inject: ["./import-meta-url-shim.js"],
  define: { "import.meta.url": "importMetaUrl" },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching for changes...");
} else {
  await esbuild.build(options);
}
