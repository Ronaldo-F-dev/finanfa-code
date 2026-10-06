import esbuild from "esbuild";

// The main process only uses Node built-ins and Electron, so it bundles to a single file; `electron` itself is provided by the runtime.
await esbuild.build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});
