#!/usr/bin/env node
// A real, standalone process standing in for the real `llama-server` binary
// — real subprocess, real spawn, real HTTP server on a real port, so
// ensureLocalTextModelServer's spawn+poll loop is tested for real without
// needing the actual multi-hundred-MB .gguf file this project's local text
// model ships as (not portable, not appropriate to fetch in a test).
import http from "node:http";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("fake-llama-server version: 0.0.0-test");
  process.exit(0);
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const modelPath = argValue("-m");
const host = argValue("--host") ?? "127.0.0.1";
const port = Number(argValue("--port"));
// llama-server reports the model as the filename it was given, minus the
// extension — reproduced here so a test can assert the right file loaded.
const modelId = modelPath?.split("/").pop()?.replace(/\.gguf$/, "") ?? "unknown-model";

const server = http.createServer((req, res) => {
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: modelId }] }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, host);
