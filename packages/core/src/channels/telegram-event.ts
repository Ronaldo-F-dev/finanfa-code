interface TelegramMessageCommon {
  /** Telegram's own update id — unique and increasing per bot, redelivered unchanged on a retry (see update-dedup.ts). */
  updateId: number;
  chatId: string;
  /** Set only in a forum-mode supergroup's topic thread — otherwise every message in that chat shares one session, keyed by chatId alone. */
  messageThreadId?: number;
  messageId: number;
}

export type TelegramMessageEvent = TelegramMessageCommon & { text: string };

/** A voice note (always Ogg/Opus) — no `text`, needs downloading + transcribing before a turn can run on it (see channels-telegram.ts). */
export type TelegramVoiceEvent = TelegramMessageCommon & { fileId: string };

/** A tap on one of the inline-keyboard buttons attached to a permission-confirmation prompt (see channels-telegram.ts) — `data` is exactly the button's own callback_data, the same y/n/a/t vocabulary PermissionManager's text-answer path already expects. */
export interface TelegramCallbackEvent {
  updateId: number;
  chatId: string;
  messageThreadId?: number;
  callbackQueryId: string;
  data: string;
}

export type ParsedTelegramUpdate =
  | { kind: "message"; event: TelegramMessageEvent }
  | { kind: "voice"; event: TelegramVoiceEvent }
  | { kind: "callback"; event: TelegramCallbackEvent }
  | { kind: "ignored" };

/**
 * Telegram's webhook payload is one "update" per call — a message is only
 * one of several update kinds (edits, callback queries, channel posts,
 * ...), and only a plain `message` with real text is worth running a turn
 * for. Unlike Slack, Telegram never echoes a bot's own sent messages back
 * as updates, so there's no bot_id-style loop-prevention check needed
 * here — from.is_bot is still checked defensively (e.g. two bots
 * messaging each other in a group).
 */
export function parseTelegramUpdate(body: unknown): ParsedTelegramUpdate {
  if (typeof body !== "object" || body === null) return { kind: "ignored" };
  const update = body as Record<string, unknown>;

  const callbackQuery = update.callback_query as Record<string, unknown> | undefined;
  if (typeof callbackQuery === "object" && callbackQuery !== null) {
    const cbFrom = callbackQuery.from as Record<string, unknown> | undefined;
    if (cbFrom?.is_bot) return { kind: "ignored" };
    const cbMessage = callbackQuery.message as Record<string, unknown> | undefined;
    const cbChat = cbMessage?.chat as Record<string, unknown> | undefined;
    if (
      (typeof cbChat?.id !== "number" && typeof cbChat?.id !== "string") ||
      typeof callbackQuery.id !== "string" ||
      typeof callbackQuery.data !== "string" ||
      typeof update.update_id !== "number"
    ) {
      return { kind: "ignored" };
    }
    return {
      kind: "callback",
      event: {
        updateId: update.update_id,
        chatId: String(cbChat.id),
        messageThreadId: typeof cbMessage?.message_thread_id === "number" ? cbMessage.message_thread_id : undefined,
        callbackQueryId: callbackQuery.id,
        data: callbackQuery.data,
      },
    };
  }

  if (typeof update.message !== "object" || update.message === null) return { kind: "ignored" };
  const message = update.message as Record<string, unknown>;

  const from = message.from as Record<string, unknown> | undefined;
  if (from?.is_bot) return { kind: "ignored" };

  const chat = message.chat as Record<string, unknown> | undefined;
  if (typeof chat?.id !== "number" && typeof chat?.id !== "string") return { kind: "ignored" };
  if (typeof message.message_id !== "number") return { kind: "ignored" };
  if (typeof update.update_id !== "number") return { kind: "ignored" };

  const common: TelegramMessageCommon = {
    updateId: update.update_id,
    chatId: String(chat.id),
    messageThreadId: typeof message.message_thread_id === "number" ? message.message_thread_id : undefined,
    messageId: message.message_id,
  };

  if (typeof message.text === "string") {
    return { kind: "message", event: { ...common, text: message.text } };
  }

  const voice = message.voice as Record<string, unknown> | undefined;
  if (typeof voice?.file_id === "string") {
    return { kind: "voice", event: { ...common, fileId: voice.file_id } };
  }

  return { kind: "ignored" };
}
