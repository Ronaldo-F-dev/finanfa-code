import type { Express } from "express";
import { verifyTelegramSecret } from "@finanfa/core/src/channels/telegram-secret.js";
import { parseTelegramUpdate } from "@finanfa/core/src/channels/telegram-event.js";
import { runHeadlessTurn } from "@finanfa/core/src/channels/headless-turn.js";
import { postTelegramMessage, telegramConfigFromEnv } from "@finanfa/core/src/tools/builtin/send-telegram-message.js";

async function handleTelegramMessage(
  cwd: string,
  sessionId: string,
  chatId: string,
  messageId: number,
  messageThreadId: number | undefined,
  text: string,
): Promise<void> {
  const config = telegramConfigFromEnv();
  // Overridable only for tests against a real local fake Telegram API —
  // real deployments always want the real https://api.telegram.org default.
  const apiBaseUrl = process.env.TELEGRAM_API_BASE_URL;
  try {
    const { replyText } = await runHeadlessTurn(cwd, sessionId, text);
    if (!replyText.trim()) return;
    if (!config) {
      console.error(`Telegram channel: got a reply but TELEGRAM_BOT_TOKEN isn't set, so it can't be posted back: ${replyText}`);
      return;
    }
    const result = await postTelegramMessage(config, { chatId, text: replyText, replyToMessageId: messageId, messageThreadId }, apiBaseUrl);
    if (!result.ok) console.error(`Telegram channel: failed to post reply to chat ${chatId}: ${result.error}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Telegram channel: turn failed for chat ${chatId}: ${message}`);
    if (config) {
      await postTelegramMessage(
        config,
        { chatId, text: "Sorry, something went wrong handling that.", replyToMessageId: messageId, messageThreadId },
        apiBaseUrl,
      ).catch(() => {});
    }
  }
}

/**
 * Wires up POST /api/channels/telegram/webhook — Telegram's Bot API
 * webhook. `cwd` is the workspace every inbound Telegram message runs
 * against (the server's own default workspace, same as channels-slack.ts
 * and a connection with no `?project=`). No-ops (via a 404 on the route
 * itself) unless TELEGRAM_WEBHOOK_SECRET is configured.
 */
export function registerTelegramChannelRoutes(app: Express, cwd: string): void {
  app.post("/api/channels/telegram/webhook", (req, res) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) {
      res.status(404).json({ error: "Telegram channel not configured — set TELEGRAM_WEBHOOK_SECRET." });
      return;
    }
    if (!verifyTelegramSecret(secret, req.header("X-Telegram-Bot-Api-Secret-Token"))) {
      res.status(401).json({ error: "Invalid Telegram secret token." });
      return;
    }

    const parsed = parseTelegramUpdate(req.body);
    // Telegram just needs a fast 200 to consider the update delivered —
    // ack immediately regardless of what kind of update this was, then
    // handle a real message asynchronously (a full agent turn can take
    // far longer than Telegram's own delivery timeout).
    res.status(200).end();
    if (parsed.kind !== "message") return;

    const { chatId, messageThreadId, messageId, text } = parsed.event;
    const sessionId = `telegram:${chatId}:${messageThreadId ?? "main"}`;
    void handleTelegramMessage(cwd, sessionId, chatId, messageId, messageThreadId, text);
  });
}
