#!/usr/bin/env node
// A real, standalone process standing in for the real `mlx_lm.server` binary
// — same rationale as fake-llama-server.mjs: a real subprocess/spawn/HTTP
// server on a real port, so ensureLocalTextModelServer's spawn+poll loop is
// tested for real without needing an actual MLX model download.
//
// Mimics the two mlx_lm.server quirks that make it a different runtime from
// llama-server: it takes --model (long flag only, no -m/-c), and it has no
// --version flag at all (exits non-zero with "unrecognized arguments") —
// only --help exits 0.
import http from "node:http";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.error("mlx_lm.server: error: unrecognized arguments: --version");
  process.exit(2);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: mlx_lm.server [-h] [--model MODEL] [--host HOST] [--port PORT]");
  process.exit(0);
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

// Real mlx_lm.server has no -m/-c flags at all — if the caller passed either,
// it built llama.cpp-shaped args instead of MLX ones. Refuse to start
// (rather than silently ignoring them) so a test relying on args being
// right sees a start-failed timeout instead of a false pass.
if (args.includes("-m") || args.includes("-c")) {
  console.error("mlx_lm.server: error: unrecognized arguments: -m/-c");
  process.exit(2);
}

const model = argValue("--model") ?? "unknown-model";
const host = argValue("--host") ?? "127.0.0.1";
const port = Number(argValue("--port"));

const server = http.createServer((req, res) => {
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    // mlx_lm.server's /v1/models reports the --model value as given (an HF
    // repo id or local dir), unlike llama-server's filename-derived stem.
    res.end(JSON.stringify({ data: [{ id: model }] }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, host);
