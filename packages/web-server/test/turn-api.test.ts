import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of POST /api/turn — the blocking, single-turn REST
// counterpart to the WS protocol (see index.ts's own doc comment on the
// route): a real subprocess (index.ts has top-level side effects — app.listen
// at import time — so it can't be exercised in-process), a real local HTTP
// server playing the OpenAI-compatible chat-completions SSE protocol so a
// real LlmProvider call actually runs, and real `fetch` calls against the
// route exactly like an n8n HTTP Request node would make.

interface TurnResponse {
  sessionId: string;
  model: string;
  providerKind: string;
  text: string;
  toolCalls: { name: string; riskLevel: string }[];
  deniedTools: string[];
  stoppedByStepLimitGuard: boolean;
  systemMessages: string[];
  errors: string[];
}

/**
 * A fake OpenAI-compatible SSE endpoint. Each request counter-based: every
 * `toolCallEveryNth`th request (1-indexed) returns a scripted tool call
 * instead of plain text, so a single test can script "first call: use a
 * tool, second call (after the tool result comes back): answer in plain
 * text" just by knowing runTurn always makes exactly one more request per
 * tool round-trip.
 */
function sseServer(opts: { toolCall?: { name: string; input: Record<string, unknown> }; replyText?: string; delayMs?: number }): {
  server: http.Server;
  baseUrl: Promise<string>;
  requestCount: () => number;
} {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const thisRequest = ++requestCount;
      const respond = () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const isToolCallTurn = opts.toolCall && thisRequest === 1;
        const events = isToolCallTurn
          ? [
              JSON.stringify({
                choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: opts.toolCall!.name, arguments: JSON.stringify(opts.toolCall!.input) } }] } }],
              }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
            ]
          : [
              JSON.stringify({ choices: [{ delta: { content: opts.replyText ?? "final answer" } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
            ];
        for (const e of events) res.write(`data: ${e}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      };
      if (opts.delayMs) setTimeout(respond, opts.delayMs);
      else respond();
    });
  });
  const baseUrl = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`));
  });
  return { server, baseUrl, requestCount: () => requestCount };
}

async function writeProjectConfig(projectDir: string, baseUrl: string): Promise<void> {
  await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".finanfa-code", "config.json"),
    JSON.stringify({ provider: "openai-compatible", baseUrl, model: "test-model", apiKey: "test-key" }),
  );
}

describe("POST /api/turn (real subprocess, real SSE provider)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-turn-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-turn-home-"));
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("runs a simple prompt synchronously and returns the final assistant text", async () => {
    const sse = sseServer({ replyText: "hello from the fake model" });
    const baseUrl = await sse.baseUrl;
    await writeProjectConfig(projectDir, baseUrl);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "say hi" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as TurnResponse;
      expect(json.text).toBe("hello from the fake model");
      expect(json.sessionId).toBeTruthy();
      expect(json.deniedTools).toEqual([]);
      expect(json.stoppedByStepLimitGuard).toBe(false);
    } finally {
      sse.server.close();
    }
  }, 20_000);

  it("resolves a tool call that needs a permission decision by denying it (non-interactive policy), instead of hanging", async () => {
    const sse = sseServer({ toolCall: { name: "bash", input: { command: "echo hi" } }, replyText: "done, could not run the command" });
    const baseUrl = await sse.baseUrl;
    await writeProjectConfig(projectDir, baseUrl);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "run echo hi" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as TurnResponse;
      expect(json.deniedTools).toContain("bash");
      expect(json.text).toBe("done, could not run the command");
    } finally {
      sse.server.close();
    }
  }, 20_000);

  it("selects the project/cwd via the same ?project= convention as other routes", async () => {
    const sse = sseServer({ replyText: "answer from the other project" });
    const baseUrl = await sse.baseUrl;

    const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "second project" }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    // The new project has its own .finanfa-code/config.json pointed at this
    // test's fake server — the default project's config (pointed at a
    // different sse instance below) must NOT be consulted for this request.
    const projectsRoot = path.join(homeDir, ".finanfa-code", "web-projects", project.id);
    await mkdir(path.join(projectsRoot, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectsRoot, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl, model: "test-model", apiKey: "test-key" }),
    );

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi", project: project.id }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as TurnResponse;
      expect(json.text).toBe("answer from the other project");

      const sessions = (await fetch(`http://127.0.0.1:${port}/api/sessions?project=${project.id}`).then((r) => r.json())) as { sessions: { id: string }[] };
      expect(sessions.sessions.some((s) => s.id === json.sessionId)).toBe(true);
    } finally {
      sse.server.close();
      await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`, { method: "DELETE" });
    }
  }, 20_000);

  it("404s an unknown project id instead of silently falling back to the default workspace", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi", project: "not-a-real-project" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s a request with no message", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns a clear timeout error instead of hanging when the turn exceeds the deadline", async () => {
    const sse = sseServer({ replyText: "too slow", delayMs: 5_000 });
    const baseUrl = await sse.baseUrl;
    await writeProjectConfig(projectDir, baseUrl);
    try {
      const start = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi", timeoutMs: 1000 }),
      });
      const elapsed = Date.now() - start;
      expect(res.status).toBe(408);
      // Aborted close to the requested 1s deadline, not the fake server's
      // full 5s delay — proves the request was actually cut off, not just
      // eventually reported as failed once the slow call itself returned.
      expect(elapsed).toBeLessThan(4_000);
      const json = (await res.json()) as { error: string };
      expect(json.error).toMatch(/timeout/i);
    } finally {
      sse.server.close();
    }
  }, 20_000);
});

describe("POST /api/turn: gateway auth gate", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let sse: ReturnType<typeof sseServer>;

  beforeAll(async () => {
    sse = sseServer({ replyText: "ok" });
    const baseUrl = await sse.baseUrl;
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-turn-auth-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-turn-auth-home-"));
    await writeProjectConfig(projectDir, baseUrl);
    process.env.FINANFA_WEB_USERS = "alice:tok-alice";
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    sse.server.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    delete process.env.FINANFA_WEB_USERS;
  });

  it("401s a turn request with no token, same as every other /api/* route", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("runs a turn once a valid bearer token is presented", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-alice" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as TurnResponse;
    expect(json.text).toBe("ok");
  });
});
