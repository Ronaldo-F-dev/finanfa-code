import type { Express } from "express";
import { verifyTelegramSecret } from "@finanfa/core/src/channels/telegram-secret.js";
import { parseTelegramUpdate } from "@finanfa/core/src/channels/telegram-event.js";
import { runHeadlessTurn } from "@finanfa/core/src/channels/headless-turn.js";
import { resolvePendingConfirmation } from "@finanfa/core/src/channels/pending-confirmations.js";
import { postTelegramMessage, answerTelegramCallbackQuery, telegramConfigFromEnv, type TelegramInlineKeyboardButton } from "@finanfa/core/src/tools/builtin/send-telegram-message.js";
import { UpdateDedupTracker } from "@finanfa/core/src/channels/update-dedup.js";
import { fetchTelegramFile } from "@finanfa/core/src/channels/telegram-file.js";
import { transcribeAudioBytes, transcribeAudioConfigFromEnv } from "@finanfa/core/src/tools/builtin/transcribe-audio.js";

// PermissionManager's own promptUser (permissions/manager.ts) always
// includes this exact substring in a permission-confirmation prompt —
// matched here so a Telegram confirmation gets real tappable buttons
// instead of asking the user to type y/n/a/t by hand. Narrow on purpose:
// only this one, well-known prompt shape gets buttons; every other
// writeSystem/writeError message (an error report, a re-prompt after an
// unrecognized answer) is sent as plain text.
const CONFIRMATION_PROMPT_MARKER = "[y]es / [n]o";

const CONFIRMATION_KEYBOARD: TelegramInlineKeyboardButton[][] = [
  [
    { text: "✅ Yes", callback_data: "y" },
    { text: "❌ No", callback_data: "n" },
  ],
  [
    { text: "Always this action", callback_data: "a" },
    { text: "Always allow this tool", callback_data: "t" },
  ],
];

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
  // Real remote-confirmation support: given to runHeadlessTurn so a tool
  // needing "ask" permission can post its confirmation question back into
  // this exact chat instead of being auto-denied outright (see
  // pending-confirmations.ts and headless-turn.ts's own askUser). Only
  // wired up when config exists — no bot token means no way to post the
  // question in the first place, so the previous auto-deny default still
  // applies exactly as before.
  const sendMessage = config
    ? async (replyText: string): Promise<void> => {
        const inlineKeyboard = replyText.includes(CONFIRMATION_PROMPT_MARKER) ? CONFIRMATION_KEYBOARD : undefined;
        const result = await postTelegramMessage(config, { chatId, text: replyText, replyToMessageId: messageId, messageThreadId, inlineKeyboard }, apiBaseUrl);
        if (!result.ok) console.error(`Telegram channel: failed to post message to chat ${chatId}: ${result.error}`);
      }
    : undefined;
  try {
    const { replyText } = await runHeadlessTurn(cwd, sessionId, text, undefined, sendMessage);
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
 * A voice note has no text — download its audio via the Bot API, transcribe
 * it (needs its own OPENAI_API_KEY, independent of the chat provider, same
 * as the transcribe_audio tool), then run the turn on the transcript
 * exactly as if it had been typed. Replies with a real error instead of
 * silently dropping the message when either prerequisite is missing.
 */
async function handleTelegramVoiceMessage(
  cwd: string,
  sessionId: string,
  chatId: string,
  messageId: number,
  messageThreadId: number | undefined,
  fileId: string,
): Promise<void> {
  const telegramConfig = telegramConfigFromEnv();
  const apiBaseUrl = process.env.TELEGRAM_API_BASE_URL;
  if (!telegramConfig) {
    console.error(`Telegram channel: got a voice note but TELEGRAM_BOT_TOKEN isn't set, can't download it.`);
    return;
  }

  const reply = (text: string) => postTelegramMessage(telegramConfig, { chatId, text, replyToMessageId: messageId, messageThreadId }, apiBaseUrl).catch(() => {});

  const transcribeConfig = transcribeAudioConfigFromEnv();
  if (!transcribeConfig) {
    await reply("Voice messages aren't supported yet — set OPENAI_API_KEY to enable transcription.");
    return;
  }

  const file = await fetchTelegramFile(telegramConfig, fileId, apiBaseUrl);
  if (!file.ok) {
    await reply(`Couldn't download that voice note: ${file.error}`);
    return;
  }

  const transcript = await transcribeAudioBytes(transcribeConfig, file.bytes, "voice.oga", file.mimeType, process.env.OPENAI_API_BASE_URL);
  if (!transcript.ok) {
    await reply(`Couldn't transcribe that voice note: ${transcript.error}`);
    return;
  }

  await handleTelegramMessage(cwd, sessionId, chatId, messageId, messageThreadId, transcript.text);
}

/**
 * Wires up POST /api/channels/telegram/webhook — Telegram's Bot API
 * webhook. `cwd` is the workspace every inbound Telegram message runs
 * against (the server's own default workspace, same as channels-slack.ts
 * and a connection with no `?project=`). No-ops (via a 404 on the route
 * itself) unless TELEGRAM_WEBHOOK_SECRET is configured.
 */
export function registerTelegramChannelRoutes(app: Express, cwd: string): void {
  const dedup = new UpdateDedupTracker();

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
    if (parsed.kind === "ignored") return;
    if (!dedup.markSeen(parsed.event.updateId)) return; // a redelivery of an update already handled — don't run a second turn or post a duplicate reply

    const { chatId, messageThreadId } = parsed.event;
    const sessionId = `telegram:${chatId}:${messageThreadId ?? "main"}`;

    if (parsed.kind === "callback") {
      // A tapped confirmation button — the tap's own callback_data is
      // exactly the y/n/a/t vocabulary PermissionManager's text-answer
      // path already expects (see CONFIRMATION_KEYBOARD above), so this
      // resolves the exact same pending confirmation a typed reply would.
      const config = telegramConfigFromEnv();
      if (config) void answerTelegramCallbackQuery(config, parsed.event.callbackQueryId, process.env.TELEGRAM_API_BASE_URL);
      resolvePendingConfirmation(sessionId, parsed.event.data);
      return;
    }

    // A text reply while this chat has a pending permission-confirmation
    // question (see pending-confirmations.ts) is the answer to that
    // question, not a new message — resolving it here hands control back
    // to the still-in-flight runHeadlessTurn call that asked it, instead
    // of starting a second, unrelated turn for what the user typed. Only
    // reachable for a user who typed y/n instead of tapping a button.
    if (parsed.kind === "message" && resolvePendingConfirmation(sessionId, parsed.event.text)) return;

    const { messageId } = parsed.event;
    if (parsed.kind === "voice") {
      void handleTelegramVoiceMessage(cwd, sessionId, chatId, messageId, messageThreadId, parsed.event.fileId);
      return;
    }
    void handleTelegramMessage(cwd, sessionId, chatId, messageId, messageThreadId, parsed.event.text);
  });
}
