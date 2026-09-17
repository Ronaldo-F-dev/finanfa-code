import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isOllamaAvailable } from "@finanfa/core/src/core/ollama-models.js";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the /api/ollama-models/* REST endpoints — same
// pattern as docker-models-api.test.ts: real subprocess, real HTTP calls
// against whatever Ollama server actually runs in this environment. Skips
// gracefully (asserting nothing) when it isn't available.
describe("web-server /api/ollama-models/* (real subprocess, real Ollama server when present)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let ollamaAvailable = false;

  beforeAll(async () => {
    ollamaAvailable = await isOllamaAvailable();

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-ollamamodels-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-ollamamodels-home-"));

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("GET /api/ollama-models/status reports real availability", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/ollama-models/status`);
    const body = (await res.json()) as { available: boolean };
    expect(res.status).toBe(200);
    expect(body.available).toBe(ollamaAvailable);
  });

  it("GET /api/ollama-models/installed returns real, well-formed entries when available", async () => {
    if (!ollamaAvailable) return;
    const res = await fetch(`http://127.0.0.1:${port}/api/ollama-models/installed`);
    const body = (await res.json()) as { models: { name: string; size: number }[] };
    expect(res.status).toBe(200);
    expect(Array.isArray(body.models)).toBe(true);
    for (const m of body.models) {
      expect(typeof m.name).toBe("string");
      expect(typeof m.size).toBe("number");
    }
  });

  it(
    "GET /api/ollama-models/pull streams real SSE progress events and a final done event for an already-cached model",
    async () => {
      if (!ollamaAvailable) return;
      const installedRes = await fetch(`http://127.0.0.1:${port}/api/ollama-models/installed`);
      const installed = ((await installedRes.json()) as { models: { name: string }[] }).models;
      if (installed.length === 0) return; // nothing pulled in this environment to re-pull cheaply

      const res = await fetch(`http://127.0.0.1:${port}/api/ollama-models/pull?name=${encodeURIComponent(installed[0]!.name)}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("event: progress");
      expect(text).toContain("event: done");
    },
    30_000,
  );

  it("DELETE /api/ollama-models rejects a nonexistent model cleanly", async () => {
    if (!ollamaAvailable) return;
    const res = await fetch(`http://127.0.0.1:${port}/api/ollama-models?name=this-model-does-not-exist-xyz`, { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });
});
