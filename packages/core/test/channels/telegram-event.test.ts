import { describe, expect, it } from "vitest";
import { parseTelegramUpdate } from "../../src/channels/telegram-event.js";

describe("parseTelegramUpdate", () => {
  it("extracts a plain message update", () => {
    expect(
      parseTelegramUpdate({
        update_id: 1,
        message: { message_id: 42, from: { id: 1, is_bot: false, username: "alice" }, chat: { id: 12345, type: "private" }, date: 1700000000, text: "hello" },
      }),
    ).toEqual({ kind: "message", event: { updateId: 1, chatId: "12345", messageThreadId: undefined, messageId: 42, text: "hello" } });
  });

  it("carries message_thread_id through for a forum-topic message", () => {
    const result = parseTelegramUpdate({
      update_id: 1,
      message: { message_id: 42, chat: { id: -100123, type: "supergroup" }, text: "hi", message_thread_id: 5 },
    });
    expect(result).toEqual({ kind: "message", event: { updateId: 1, chatId: "-100123", messageThreadId: 5, messageId: 42, text: "hi" } });
  });

  it("ignores a message from a bot (defensive — Telegram itself never echoes our own sent messages back)", () => {
    expect(
      parseTelegramUpdate({
        update_id: 1,
        message: { message_id: 42, from: { id: 1, is_bot: true }, chat: { id: 12345, type: "private" }, text: "an echo" },
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("ignores an edited_message update — not a new message to react to", () => {
    expect(
      parseTelegramUpdate({
        update_id: 1,
        edited_message: { message_id: 42, chat: { id: 12345, type: "private" }, text: "edited" },
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("ignores a malformed callback_query missing the fields a real one always has", () => {
    expect(parseTelegramUpdate({ update_id: 1, callback_query: { id: "abc" } })).toEqual({ kind: "ignored" });
  });

  // Real, reported feature: a permission-confirmation prompt sent to a
  // channel now gets real tappable buttons (see channels-telegram.ts's
  // CONFIRMATION_KEYBOARD) instead of asking the user to type y/n/a/t —
  // this is Telegram's real callback_query payload shape for a button tap.
  it("extracts a real callback_query (a tapped confirmation button)", () => {
    const result = parseTelegramUpdate({
      update_id: 7,
      callback_query: {
        id: "cbq123",
        from: { id: 1, is_bot: false },
        message: { message_id: 99, chat: { id: 12345, type: "private" } },
        data: "y",
      },
    });
    expect(result).toEqual({ kind: "callback", event: { updateId: 7, chatId: "12345", messageThreadId: undefined, callbackQueryId: "cbq123", data: "y" } });
  });

  it("carries message_thread_id through for a callback tapped inside a forum topic", () => {
    const result = parseTelegramUpdate({
      update_id: 7,
      callback_query: {
        id: "cbq123",
        message: { message_id: 99, chat: { id: -100123, type: "supergroup" }, message_thread_id: 5 },
        data: "n",
      },
    });
    expect(result).toEqual({ kind: "callback", event: { updateId: 7, chatId: "-100123", messageThreadId: 5, callbackQueryId: "cbq123", data: "n" } });
  });

  it("ignores a callback_query from a bot (defensive, same as a message)", () => {
    expect(
      parseTelegramUpdate({
        update_id: 7,
        callback_query: { id: "cbq123", from: { is_bot: true }, message: { message_id: 99, chat: { id: 12345 } }, data: "y" },
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("extracts a voice note message by its file_id, for later download + transcription", () => {
    const result = parseTelegramUpdate({
      update_id: 1,
      message: { message_id: 42, chat: { id: 12345, type: "private" }, voice: { file_id: "AABBCC", file_unique_id: "x", duration: 3, mime_type: "audio/ogg" } },
    });
    expect(result).toEqual({ kind: "voice", event: { updateId: 1, chatId: "12345", messageThreadId: undefined, messageId: 42, fileId: "AABBCC" } });
  });

  it("ignores a message with neither text nor a voice note (e.g. a sticker)", () => {
    expect(parseTelegramUpdate({ update_id: 1, message: { message_id: 42, chat: { id: 12345 }, sticker: { file_id: "x" } } })).toEqual({ kind: "ignored" });
  });

  it("ignores an update with no update_id — needed for redelivery dedup, so a malformed/missing one can't silently skip that check", () => {
    expect(
      parseTelegramUpdate({
        message: { message_id: 42, chat: { id: 12345, type: "private" }, text: "hello" },
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("ignores malformed/non-object input instead of throwing", () => {
    expect(parseTelegramUpdate(null)).toEqual({ kind: "ignored" });
    expect(parseTelegramUpdate("not an object")).toEqual({ kind: "ignored" });
    expect(parseTelegramUpdate({ update_id: 1, message: { chat: { id: 1 } } })).toEqual({ kind: "ignored" });
  });
});
