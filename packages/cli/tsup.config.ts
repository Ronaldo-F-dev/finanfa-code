import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["bin/finanfa.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  outDir: "dist",
  // @finanfa/core is a workspace package shipped as TS source, not a real
  // published npm package — it has to be compiled into the bundle here,
  // unlike genuine external deps (ink, commander, ...) which stay external.
  noExternal: ["@finanfa/core"],
  // tsup's default external-detection only reads this package's own
  // package.json, not @finanfa/core's — so once @finanfa/core's source is
  // force-bundled above, esbuild would otherwise also try to bundle every
  // real npm package *it* imports (playwright-core, sharp, ...), pulling in
  // their own optional/native sub-dependencies and failing. List them
  // explicitly so they stay external, matching @finanfa/core/package.json's
  // own "dependencies".
  external: [
    "@anthropic-ai/bedrock-sdk",
    "@anthropic-ai/sdk",
    "@anthropic-ai/vertex-sdk",
    "@aws-sdk/client-bedrock",
    "@modelcontextprotocol/sdk",
    "@opentelemetry/api",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/resources",
    "@opentelemetry/sdk-trace-node",
    "@opentelemetry/semantic-conventions",
    "coap",
    "diff",
    "docx",
    "exceljs",
    "fast-glob",
    "fonika_translate",
    "google-translate-api-x",
    "gray-matter",
    "jszip",
    "mammoth",
    "marked",
    "mqtt",
    "mysql2",
    "nodemailer",
    "pdf-lib",
    "pdf-parse",
    "pg",
    "playwright-core",
    "serialport",
    "sharp",
    "tree-sitter-wasms",
    "undici",
    "web-tree-sitter",
    "word-extractor",
  ],
});
