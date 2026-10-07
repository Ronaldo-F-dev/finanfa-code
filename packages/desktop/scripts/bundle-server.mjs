import esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Builds what the installed app runs as its background server: one bundled file (server.mjs) plus the few packages that
// cannot be bundled because they carry native code, copied with their own dependencies into server/node_modules.
// Run on each operating system by the installer workflow: the native packages copied are the ones npm installed for
// THAT system, which is what makes the macOS, Windows and Linux installers each carry the right binaries.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const outDir = path.resolve(here, "..", "build", "server");

// Packages that cannot be bundled: native code (sharp, serialport, @napi-rs/canvas) or code that reads its own files
// (playwright-core, web-tree-sitter and its grammars).
const SHIPPED_NATIVE = ["sharp", "serialport", "@napi-rs/canvas", "playwright-core", "web-tree-sitter", "tree-sitter-wasms"];
// Never shipped: the local embedding model (about 400 MB of runtime). The feature loads it on demand and reports it
// missing, instead of every install paying for it.
const LEFT_OUT = ["@huggingface/transformers", "onnxruntime-node", "onnxruntime-web", "chromium-bidi", "chromium-bidi/*", "electron"];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(repoRoot, "packages", "web-server", "src", "index.ts")],
  outfile: path.join(outDir, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: [...SHIPPED_NATIVE.flatMap((n) => [n, `${n}/*`]), ...LEFT_OUT],
  // Some bundled dependencies are CommonJS and use require(), __filename and __dirname, which an ES module does not define.
  banner: {
    js:
      'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameOf } from "node:path"; ' +
      "const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename);",
  },
  sourcemap: false,
  logLevel: "warning",
});

const nodeModules = path.join(repoRoot, "node_modules");
const copied = new Set();

function packageDir(name, from) {
  for (const base of [path.join(from ?? repoRoot, "node_modules"), nodeModules]) {
    const dir = path.join(base, name);
    if (existsSync(path.join(dir, "package.json"))) return dir;
  }
  return undefined;
}

/** Copies a package and, recursively, every dependency (including optional ones such as a platform binary) that npm installed. */
function copyWithDependencies(name, from) {
  if (copied.has(name)) return;
  const dir = packageDir(name, from);
  if (!dir) return; // an optional dependency for another platform
  copied.add(name);
  cpSync(dir, path.join(outDir, "node_modules", name), { recursive: true, dereference: true, filter: (src) => !/[\\/](test|tests|docs|\.github)[\\/]/.test(src) });
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"));
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) copyWithDependencies(dep, dir);
}

for (const name of SHIPPED_NATIVE) copyWithDependencies(name);

// tree-sitter-wasms carries a grammar for dozens of languages (about 50 MB); the repo map only loads the ones it lists.
const wanted = new Set([...readFileSync(path.join(repoRoot, "packages", "core", "src", "tools", "builtin", "repo-map", "languages.ts"), "utf-8").matchAll(/wasmFile: "([^"]+)"/g)].map((m) => m[1]));
const grammarDir = path.join(outDir, "node_modules", "tree-sitter-wasms", "out");
if (wanted.size > 0 && existsSync(grammarDir)) {
  for (const file of readdirSync(grammarDir)) if (file.endsWith(".wasm") && !wanted.has(file)) rmSync(path.join(grammarDir, file));
}

const size = (dir) => {
  let total = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
};
console.log(`server bundle ready in ${path.relative(process.cwd(), outDir)}: ${(size(outDir) / 1e6).toFixed(1)} MB, native packages: ${[...copied].join(", ")}`);
