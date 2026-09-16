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

  it("ignores a non-message update (e.g. callback_query)", () => {
    expect(parseTelegramUpdate({ update_id: 1, callback_query: { id: "abc" } })).toEqual({ kind: "ignored" });
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
