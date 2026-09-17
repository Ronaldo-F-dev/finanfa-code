import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDockerModelRunnerAvailable } from "@finanfa/core/src/core/docker-models.js";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the /api/docker-models/* REST endpoints: spawns
// the real web server as a subprocess (same reasoning as
// trust-and-hooks.test.ts — index.ts has top-level side effects at import
// time) and hits them with real fetch calls against the real `docker
// model` CLI genuinely installed in this environment. Skips gracefully
// (asserting nothing) when it isn't — same convention as
// local-providers.test.ts/docker-models.test.ts.
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

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
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

  it("DELETE /api/docker-models requires a name", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/docker-models`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it(
    "DELETE /api/docker-models?name=... reports a real failure for a model that doesn't exist, without ever touching a real pulled model",
    async () => {
      // Deliberately does not exercise the success path here — this
      // environment's real pulled models are relied on by the other tests
      // above (and local-providers.test.ts's real-detection test), so
      // actually deleting one would be a destructive side effect on shared
      // real state this test doesn't own. This still proves the route is
      // wired to the real deleteDockerModel/`docker model rm` call and
      // surfaces its real failure as a 400, not a silently-swallowed error.
      if (!dmrAvailable) return;
      const res = await fetch(`http://127.0.0.1:${port}/api/docker-models?name=this-model-definitely-does-not-exist-xyz123`, { method: "DELETE" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/no such model|not found/i);
    },
    15_000,
  );
});
