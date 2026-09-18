import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of the Telegram inbound channel — same shape as
// channels-slack.test.ts: the real web-server subprocess, a real fake LLM
// server, and a real fake Telegram Bot API server capturing the outgoing
// sendMessage call. Provider config goes through a real project
// .finanfa-code/config.json rather than FINANFA_* env vars, since
// spawnWebServer strips those unconditionally (see its own comment).

const WEBHOOK_SECRET = "test-webhook-secret";

function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function postTelegramUpdate(port: number, payload: unknown, secretToken: string | undefined = WEBHOOK_SECRET): Promise<{ status: number }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secretToken !== undefined) headers["X-Telegram-Bot-Api-Secret-Token"] = secretToken;
  const res = await fetch(`http://127.0.0.1:${port}/api/channels/telegram/webhook`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return { status: res.status };
}

describe("web-server Telegram inbound channel (real subprocess, real fake LLM + Telegram API servers)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  let llmServer: http.Server;
  let llmBaseUrl: string;
  let replyText: string;

  let telegramApiServer: http.Server;
  let telegramApiBaseUrl: string;
  let sentMessages: { url: string; body: { chat_id: string; text: string; reply_to_message_id?: number } }[];

  let openaiServer: http.Server;
  let openaiBaseUrl: string;
  let transcriptText: string;
  let openaiRequestBodies: Buffer[];

  beforeAll(async () => {
    llmServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    llmBaseUrl = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}`;

    telegramApiServer = http.createServer((req, res) => {
      if (req.url?.startsWith("/bot123:test-bot-token/getFile")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { file_path: "voice/file_1.oga" } }));
        return;
      }
      if (req.url === "/file/bot123:test-bot-token/voice/file_1.oga") {
        res.writeHead(200, { "content-type": "audio/ogg" });
        res.end(Buffer.from("fake ogg opus voice bytes"));
        return;
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        sentMessages.push({ url: req.url ?? "", body: JSON.parse(raw) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 99 } }));
      });
    });
    await new Promise<void>((resolve) => telegramApiServer.listen(0, "127.0.0.1", resolve));
    telegramApiBaseUrl = `http://127.0.0.1:${(telegramApiServer.address() as AddressInfo).port}`;

    openaiServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        openaiRequestBodies.push(Buffer.concat(chunks));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: transcriptText }));
      });
    });
    await new Promise<void>((resolve) => openaiServer.listen(0, "127.0.0.1", resolve));
    openaiBaseUrl = `http://127.0.0.1:${(openaiServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-telegram-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-telegram-home-"));

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.TELEGRAM_BOT_TOKEN = "123:test-bot-token";
    process.env.TELEGRAM_API_BASE_URL = telegramApiBaseUrl;
    process.env.OPENAI_API_KEY = "sk-test-key";
    process.env.OPENAI_API_BASE_URL = openaiBaseUrl;

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    telegramApiServer.close();
    openaiServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    for (const k of ["TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_API_BASE_URL", "OPENAI_API_KEY", "OPENAI_API_BASE_URL"]) delete process.env[k];
  });

  it("rejects a request with an invalid/missing secret token", async () => {
    const { status } = await postTelegramUpdate(port, { update_id: 1, message: { message_id: 1, chat: { id: 1 }, text: "x" } }, "wrong-secret");
    expect(status).toBe(401);
  });

  it(
    "runs a real turn for an inbound message and replies to the right chat/message",
    async () => {
      sentMessages = [];
      replyText = "hello from the agent";

      const { status } = await postTelegramUpdate(port, {
        update_id: 1,
        message: { message_id: 7, from: { id: 1, is_bot: false }, chat: { id: 555, type: "private" }, text: "hi there" },
      });
      expect(status).toBe(200);

      await waitFor(() => sentMessages.length > 0, 20_000);
      expect(sentMessages[0]!.url).toBe("/bot123:test-bot-token/sendMessage");
      expect(sentMessages[0]!.body).toMatchObject({ chat_id: "555", text: "hello from the agent", reply_to_message_id: 7 });
    },
    30_000,
  );

  it("ignores a redelivery of the same update_id — no second turn, no duplicate reply", async () => {
    sentMessages = [];
    replyText = "second reply that should never be sent";

    const { status } = await postTelegramUpdate(port, {
      update_id: 1, // same update_id already handled by the earlier test in this file
      message: { message_id: 7, from: { id: 1, is_bot: false }, chat: { id: 555, type: "private" }, text: "hi there" },
    });
    expect(status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentMessages).toHaveLength(0);
  });

  it(
    "downloads and transcribes a real inbound voice note, then runs a turn on the transcript",
    async () => {
      sentMessages = [];
      openaiRequestBodies = [];
      transcriptText = "what is the capital of France";
      replyText = "reply to the transcribed voice note";

      const { status } = await postTelegramUpdate(port, {
        update_id: 3,
        message: { message_id: 9, from: { id: 1, is_bot: false }, chat: { id: 555, type: "private" }, voice: { file_id: "AABBCC", file_unique_id: "x", duration: 2 } },
      });
      expect(status).toBe(200);

      await waitFor(() => sentMessages.length > 0, 20_000);
      expect(openaiRequestBodies[0]?.includes("fake ogg opus voice bytes")).toBe(true);
      expect(sentMessages[0]!.body).toMatchObject({ chat_id: "555", text: "reply to the transcribed voice note", reply_to_message_id: 9 });
    },
    30_000,
  );

  it("ignores a non-message update (e.g. an edited_message) — no reply sent", async () => {
    sentMessages = [];
    const { status } = await postTelegramUpdate(port, {
      update_id: 2,
      edited_message: { message_id: 8, chat: { id: 555 }, text: "edited" },
    });
    expect(status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentMessages).toHaveLength(0);
  });
});

// Real, reported feature: a permission-confirmation prompt now goes back
// out through the same Telegram chat with real tappable buttons, and a
// tapped button (a real callback_query update) resolves the exact same
// pending confirmation a typed y/n reply would — own dedicated subprocess/
// servers so this doesn't touch the plain-text-reply fixtures above at all.
describe("web-server Telegram inbound channel — real remote confirmation via inline buttons", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  let llmServer: http.Server;
  let llmBaseUrl: string;
  let callCount: number;

  let telegramApiServer: http.Server;
  let telegramApiBaseUrl: string;
  let sentMessages: { url: string; body: { chat_id: string; text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } } }[];

  beforeAll(async () => {
    llmServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        callCount++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (callCount === 1) {
          const events = [
            JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: "" } }] } }] }),
            JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"note.txt","content":"hi"}' } }] } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ];
          for (const e of events) res.write(`data: ${e}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    llmBaseUrl = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}`;

    telegramApiServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        sentMessages.push({ url: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 99 } }));
      });
    });
    await new Promise<void>((resolve) => telegramApiServer.listen(0, "127.0.0.1", resolve));
    telegramApiBaseUrl = `http://127.0.0.1:${(telegramApiServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-telegram-confirm-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-telegram-confirm-home-"));

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl: llmBaseUrl, model: "test-model", apiKey: "test-key" }),
    );

    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.TELEGRAM_BOT_TOKEN = "123:test-bot-token";
    process.env.TELEGRAM_API_BASE_URL = telegramApiBaseUrl;

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    llmServer.close();
    telegramApiServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    for (const k of ["TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_API_BASE_URL"]) delete process.env[k];
  });

  beforeEach(() => {
    callCount = 0;
    sentMessages = [];
  });

  it("sends the confirmation prompt with real inline buttons, and a tapped button (callback_query) runs the tool", async () => {
    await postTelegramUpdate(port, { update_id: 10, message: { message_id: 1, chat: { id: 777 }, text: "write a note" } });

    await waitFor(() => sentMessages.some((m) => m.body.text?.includes('wants to run "write_file"')));
    const confirmationMessage = sentMessages.find((m) => m.body.text?.includes('wants to run "write_file"'));
    expect(confirmationMessage?.body.reply_markup?.inline_keyboard).toEqual([
      [
        { text: "✅ Yes", callback_data: "y" },
        { text: "❌ No", callback_data: "n" },
      ],
      [
        { text: "Always this action", callback_data: "a" },
        { text: "Always allow this tool", callback_data: "t" },
      ],
    ]);

    // The real Telegram callback_query shape for a tap on the "✅ Yes" button.
    await postTelegramUpdate(port, {
      update_id: 11,
      callback_query: { id: "cbq1", from: { id: 1, is_bot: false }, message: { message_id: 99, chat: { id: 777 } }, data: "y" },
    });

    await waitFor(() => sentMessages.some((m) => m.body.text === "Done."));
    expect(await readFile(path.join(projectDir, "note.txt"), "utf-8")).toBe("hi");
    // answerCallbackQuery, not another sendMessage, is what acks the tap itself.
    expect(sentMessages.some((m) => m.url.includes("answerCallbackQuery"))).toBe(true);
  });
});

describe("web-server Telegram inbound channel — not configured", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-telegram-unconfigured-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-telegram-unconfigured-home-"));
    for (const k of ["TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_API_BASE_URL"]) delete process.env[k];
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("404s instead of silently accepting unverifiable requests when TELEGRAM_WEBHOOK_SECRET isn't set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(404);
  });
});
