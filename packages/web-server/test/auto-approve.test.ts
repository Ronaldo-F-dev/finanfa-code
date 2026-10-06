import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { killWebServer, spawnWebServer } from "./support/spawn-server.js";
import { connectWebSocket, type WsEvent } from "./support/ws-harness.js";

// "Approve this kind of call without asking": a real server and WebSocket, a scripted model that writes one file
// per message. The setting must apply immediately, survive into the next conversation, and leave the rest of the
// user's config alone.

function scriptedModel() {
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const messages = (JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> }).messages;
      const isTitle = messages.some((m) => m.role === "system" && String(m.content).includes("short title"));
      const call = !isTitle && messages.at(-1)?.role === "user";
      const file = `note-${++n}.txt`;
      const events = call
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: `c${n}`, function: { name: "write_file", arguments: JSON.stringify({ path: file, content: "hi\n" }) } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ]
        : [{ choices: [{ delta: { content: isTitle ? "A title" : "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
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
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for event: ${JSON.stringify(events.map((e) => e.type))}`));
      setTimeout(check, 50);
    };
    check();
  });
}

const exists = (p: string) => stat(p).then(() => true, () => false);

describe("per-category auto-approval (real subprocess, real WebSocket, scripted model)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams | undefined;
  let port: number;
  let model: ReturnType<typeof scriptedModel>;
  const globalConfig = () => path.join(homeDir, ".finanfa-code", "config.json");

  async function start(extraEnv: NodeJS.ProcessEnv = {}, existingGlobalConfig?: object) {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-approve-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-approve-home-"));
    model = scriptedModel();
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(path.join(projectDir, ".finanfa-code", "config.json"), JSON.stringify({ provider: "openai-compatible", baseUrl: await model.baseUrl, model: "fake-model", apiKey: "test-key" }));
    if (existingGlobalConfig) {
      await mkdir(path.dirname(globalConfig()), { recursive: true });
      await writeFile(globalConfig(), JSON.stringify(existingGlobalConfig));
    }
    ({ child, port } = await spawnWebServer(projectDir, homeDir, extraEnv));
  }

  beforeEach(() => {
    child = undefined;
  });
  afterEach(async () => {
    if (child) killWebServer(child);
    model?.server.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("starts with nothing auto-approved, applies a switch at once, and keeps the user's other config", async () => {
    const existing = { rules: [{ tool: "bash", decision: "ask" }], someOtherKey: { a: 1 } };
    await start({}, existing);
    const { ws, events } = await connectWebSocket(port);
    const initial = await waitFor(events, (e) => e.type === "auto_approve");
    expect(initial).toMatchObject({ settings: {}, forbidden: false, categories: ["edits", "terminal", "mcp"] });

    ws.send(JSON.stringify({ type: "set_auto_approve", category: "edits", enabled: true }));
    await waitFor(events, (e) => e.type === "auto_approve" && (e.settings as Record<string, boolean>).edits === true);
    expect(JSON.parse(await readFile(globalConfig(), "utf-8"))).toEqual({ ...existing, autoApprove: { edits: true } });

    // A file write now goes through without any approval prompt.
    ws.send(JSON.stringify({ type: "user_message", text: "write a note" }));
    await waitFor(events, (e) => e.type === "tool_result");
    expect(events.some((e) => e.type === "ask")).toBe(false);
    expect(await exists(path.join(projectDir, "note-1.txt"))).toBe(true);
    ws.close();
  }, 60_000);

  it("is remembered: a new conversation starts with the category already on, and switching one off keeps the others", async () => {
    await start();
    const first = await connectWebSocket(port);
    await waitFor(first.events, (e) => e.type === "auto_approve");
    first.ws.send(JSON.stringify({ type: "set_auto_approve", category: "edits", enabled: true }));
    first.ws.send(JSON.stringify({ type: "set_auto_approve", category: "terminal", enabled: true }));
    await waitFor(first.events, (e) => e.type === "auto_approve" && (e.settings as Record<string, boolean>).terminal === true);
    first.ws.close();

    const second = await connectWebSocket(port);
    const restored = await waitFor(second.events, (e) => e.type === "auto_approve");
    expect(restored.settings).toEqual({ edits: true, terminal: true });

    second.ws.send(JSON.stringify({ type: "set_auto_approve", category: "edits", enabled: false }));
    await waitFor(second.events, (e) => e.type === "auto_approve" && (e.settings as Record<string, boolean>).edits === false);
    expect(JSON.parse(await readFile(globalConfig(), "utf-8")).autoApprove).toEqual({ edits: false, terminal: true });
    second.ws.close();
  }, 60_000);

  it("asks again for a category that is switched off", async () => {
    await start();
    const { ws, events } = await connectWebSocket(port);
    await waitFor(events, (e) => e.type === "auto_approve");
    ws.send(JSON.stringify({ type: "user_message", text: "write a note" }));
    const ask = await waitFor(events, (e) => e.type === "ask");
    expect(ask.filePreview).toMatchObject({ path: "note-1.txt" });
    ws.send(JSON.stringify({ type: "permission_response", requestId: ask.requestId, answer: "n" }));
    await waitFor(events, (e) => e.type === "checkpoints");
    expect(await exists(path.join(projectDir, "note-1.txt"))).toBe(false);
    ws.close();
  }, 60_000);

  it("ignores an unknown category or a non-boolean value, changing and saving nothing", async () => {
    await start();
    const { ws, events } = await connectWebSocket(port);
    await waitFor(events, (e) => e.type === "auto_approve");
    const before = events.length;
    ws.send(JSON.stringify({ type: "set_auto_approve", category: "everything", enabled: true }));
    ws.send(JSON.stringify({ type: "set_auto_approve", category: "edits", enabled: "yes" }));
    ws.send(JSON.stringify({ type: "set_auto_approve" }));
    // a later, valid message proves the earlier ones were processed (they are handled in order)
    ws.send(JSON.stringify({ type: "set_auto_approve", category: "mcp", enabled: true }));
    await waitFor(events, (e) => e.type === "auto_approve" && events.indexOf(e) >= before);
    const updates = events.slice(before).filter((e) => e.type === "auto_approve");
    expect(updates).toHaveLength(1);
    expect(updates[0].settings).toEqual({ mcp: true });
    ws.close();
  }, 60_000);

  it("is refused when the machine's managed settings forbid skipping approvals", async () => {
    const policyDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-approve-policy-"));
    const policy = path.join(policyDir, "managed.json");
    await writeFile(policy, JSON.stringify({ disableYolo: true }));
    await start({ FINANFA_MANAGED_SETTINGS: policy });
    const { ws, events } = await connectWebSocket(port);
    const initial = await waitFor(events, (e) => e.type === "auto_approve");
    expect(initial.forbidden).toBe(true);

    ws.send(JSON.stringify({ type: "set_auto_approve", category: "edits", enabled: true }));
    await waitFor(events, (e) => e.type === "error" && String(e.text).includes("managed settings"));
    expect(await exists(globalConfig())).toBe(false);

    ws.send(JSON.stringify({ type: "user_message", text: "write a note" }));
    await waitFor(events, (e) => e.type === "ask"); // still asked
    ws.close();
    await rm(policyDir, { recursive: true, force: true });
  }, 60_000);
});
