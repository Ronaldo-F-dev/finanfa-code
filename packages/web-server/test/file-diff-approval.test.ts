import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";
import { connectWebSocket, type WsEvent } from "./support/ws-harness.js";

// Approving a file edit in the web UI shows a real diff: the "ask" event for an edit carries the file's
// before/after contents (not only the tool's text preview), which the browser turns into a coloured diff.
// A real server, a real WebSocket and a scripted OpenAI-compatible model that asks for one edit, then finishes.

function scriptedModel(call: { name: string; input: Record<string, unknown> }) {
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const toolTurn = requests++ % 2 === 0;
      const events = toolTurn
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: call.name, arguments: JSON.stringify(call.input) } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
          ]
        : [{ choices: [{ delta: { content: "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }];
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const baseUrl = new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)));
  return { server, baseUrl };
}

function waitFor(events: WsEvent[], predicate: (e: WsEvent) => boolean, timeoutMs = 30_000): Promise<WsEvent> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for event: ${JSON.stringify(events)}`));
      setTimeout(check, 50);
    };
    check();
  });
}

async function runScenario(call: { name: string; input: Record<string, unknown> }, setup: (projectDir: string) => Promise<void>) {
  const projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-diff-project-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-diff-home-"));
  await setup(projectDir);
  const model = scriptedModel(call);
  const baseUrl = await model.baseUrl;
  await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
  await writeFile(path.join(projectDir, ".finanfa-code", "config.json"), JSON.stringify({ provider: "openai-compatible", baseUrl, model: "fake-model", apiKey: "test-key" }));
  const { child, port } = await spawnWebServer(projectDir, homeDir);
  const cleanup = async (c: ChildProcessWithoutNullStreams) => {
    killWebServer(c);
    model.server.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  };
  return { projectDir, port, child, cleanup };
}

describe("file edits are approved with a before/after the UI can diff (real subprocess, real WebSocket, scripted model)", () => {
  let ctx: Awaited<ReturnType<typeof runScenario>>;

  afterAll(async () => {
    await ctx?.cleanup(ctx.child);
  });

  describe("edit_file on an existing file", () => {
    beforeAll(async () => {
      ctx = await runScenario({ name: "edit_file", input: { path: "greeting.txt", old_string: "hello", new_string: "goodbye" } }, (dir) => writeFile(path.join(dir, "greeting.txt"), "line one\nhello world\nline three\n"));
    }, 30_000);

    it("sends the file's contents before and after the edit, and applies it only once approved", async () => {
      const { ws, events } = await connectWebSocket(ctx.port);
      await waitFor(events, (e) => e.type === "session_info");
      ws.send(JSON.stringify({ type: "user_message", text: "change the greeting" }));

      const ask = await waitFor(events, (e) => e.type === "ask");
      expect(ask.filePreview).toEqual({ path: "greeting.txt", before: "line one\nhello world\nline three\n", after: "line one\ngoodbye world\nline three\n" });
      expect(String(ask.prompt)).toContain("edit_file");
      // Not applied yet: the approval is what lets it through.
      expect(await readFile(path.join(ctx.projectDir, "greeting.txt"), "utf-8")).toContain("hello world");

      ws.send(JSON.stringify({ type: "permission_response", requestId: ask.requestId, answer: "y" }));
      await waitFor(events, (e) => e.type === "tool_result");
      expect(await readFile(path.join(ctx.projectDir, "greeting.txt"), "utf-8")).toContain("goodbye world");
      ws.close();
    }, 45_000);
  });
});

describe("a denied edit leaves the file alone", () => {
  let ctx: Awaited<ReturnType<typeof runScenario>>;

  beforeAll(async () => {
    ctx = await runScenario({ name: "edit_file", input: { path: "keep.txt", old_string: "keep", new_string: "lose" } }, (dir) => writeFile(path.join(dir, "keep.txt"), "keep me\n"));
  }, 30_000);
  afterAll(async () => {
    await ctx?.cleanup(ctx.child);
  });

  it("does not change the file when the user says no", async () => {
    const { ws, events } = await connectWebSocket(ctx.port);
    await waitFor(events, (e) => e.type === "session_info");
    ws.send(JSON.stringify({ type: "user_message", text: "edit it" }));
    const ask = await waitFor(events, (e) => e.type === "ask");
    expect(ask.filePreview).toMatchObject({ path: "keep.txt", before: "keep me\n", after: "lose me\n" });
    ws.send(JSON.stringify({ type: "permission_response", requestId: ask.requestId, answer: "n" }));
    await waitFor(events, (e) => e.type === "assistant_end");
    expect(await readFile(path.join(ctx.projectDir, "keep.txt"), "utf-8")).toBe("keep me\n");
    ws.close();
  }, 45_000);
});
