import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDockerModelRunnerAvailable } from "@finanfa/core/src/core/docker-models.js";

// Real end-to-end test of the /api/docker-models/* REST endpoints: spawns
// the real web server as a subprocess (same reasoning as
// trust-and-hooks.test.ts — index.ts has top-level side effects at import
// time) and hits them with real fetch calls against the real `docker
// model` CLI genuinely installed in this environment. Skips gracefully
// (asserting nothing) when it isn't — same convention as
// local-providers.test.ts/docker-models.test.ts.
const webServerDir = path.dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, "");

async function waitForServerReady(child: ChildProcessWithoutNullStreams, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("web server did not start in time")), 15_000);
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(`listening on http://localhost:${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (d: Buffer) => (buf += d.toString()));
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`web server exited early (code ${code}): ${buf}`));
    });
  });
}

describe("web-server /api/docker-models/* (real subprocess, real `docker model` CLI when present)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let dmrAvailable = false;

  beforeAll(async () => {
    dmrAvailable = await isDockerModelRunnerAvailable();

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-dockermodels-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-dockermodels-home-"));

    port = 4800 + Math.floor(Math.random() * 500);
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), FINANFA_WEB_CWD: projectDir, HOME: homeDir };
    for (const k of ["FINANFA_PROVIDER", "FINANFA_BASE_URL", "FINANFA_MODEL", "FINANFA_API_KEY", "FINANFA_API_KEYS", "ANTHROPIC_API_KEY"]) delete env[k];

    child = spawn("npx", ["tsx", "src/index.ts"], { cwd: webServerDir, env }) as ChildProcessWithoutNullStreams;
    await waitForServerReady(child, port);
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("GET /api/docker-models/status reports real availability", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/docker-models/status`);
    const body = (await res.json()) as { available: boolean };
    expect(res.status).toBe(200);
    expect(body.available).toBe(dmrAvailable);
  });

  it("GET /api/docker-models/installed returns real, well-formed entries when available", async () => {
    if (!dmrAvailable) return;
    const res = await fetch(`http://127.0.0.1:${port}/api/docker-models/installed`);
    const body = (await res.json()) as { models: { id: string; tags: string[] }[] };
    expect(res.status).toBe(200);
    expect(Array.isArray(body.models)).toBe(true);
    for (const m of body.models) {
      expect(typeof m.id).toBe("string");
      expect(Array.isArray(m.tags)).toBe(true);
    }
  });

  it(
    "GET /api/docker-models/search returns real catalog results when available",
    async () => {
      if (!dmrAvailable) return;
      const res = await fetch(`http://127.0.0.1:${port}/api/docker-models/search?q=qwen`);
      const body = (await res.json()) as { results: { name: string }[] };
      expect(res.status).toBe(200);
      expect(body.results.length).toBeGreaterThan(0);
    },
    20_000,
  );

  it("GET /api/docker-models/pull requires a name", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/docker-models/pull`);
    expect(res.status).toBe(400);
  });

  it(
    "GET /api/docker-models/pull streams real SSE line events and a final done event for an already-cached model",
    async () => {
      if (!dmrAvailable) return;
      const installedRes = await fetch(`http://127.0.0.1:${port}/api/docker-models/installed`);
      const { models } = (await installedRes.json()) as { models: { tags: string[] }[] };
      const cachedTag = models[0]?.tags[0]?.replace(/^docker\.io\//, "");
      if (!cachedTag) return;

      const res = await fetch(`http://127.0.0.1:${port}/api/docker-models/pull?name=${encodeURIComponent(cachedTag)}`);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("event: line");
      expect(text).toContain("event: done");
    },
    30_000,
  );
});
