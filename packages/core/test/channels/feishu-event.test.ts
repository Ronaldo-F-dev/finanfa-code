import { describe, expect, it } from "vitest";
import { extractFeishuToken, parseFeishuPayload } from "../../src/channels/feishu-event.js";

describe("extractFeishuToken", () => {
  it("extracts a top-level token (url_verification challenge)", () => {
    expect(extractFeishuToken({ type: "url_verification", challenge: "c", token: "top-level-token" })).toBe("top-level-token");
  });

  it("extracts header.token (a real schema 2.0 event)", () => {
    expect(extractFeishuToken({ header: { token: "nested-token" } })).toBe("nested-token");
  });

  it("returns undefined for malformed/missing input instead of throwing", () => {
    expect(extractFeishuToken(null)).toBeUndefined();
    expect(extractFeishuToken({})).toBeUndefined();
    expect(extractFeishuToken({ header: {} })).toBeUndefined();
  });
});

describe("parseFeishuPayload", () => {
  it("extracts the challenge from a url_verification handshake", () => {
    expect(parseFeishuPayload({ type: "url_verification", challenge: "abc123", token: "t" })).toEqual({ kind: "url_verification", challenge: "abc123" });
  });

  it("extracts a plain text message event", () => {
    const body = {
      schema: "2.0",
      header: { event_id: "evt1", event_type: "im.message.receive_v1", token: "t" },
      event: {
        sender: { sender_id: { open_id: "ou_1" }, sender_type: "user" },
        message: { message_id: "m1", chat_id: "oc_1", message_type: "text", content: JSON.stringify({ text: "hello" }) },
      },
    };
    expect(parseFeishuPayload(body)).toEqual({ kind: "message", event: { eventId: "evt1", chatId: "oc_1", text: "hello" } });
  });

  it("ignores a message from an app sender (defensive — Feishu itself doesn't normally echo the bot's own messages)", () => {
    const body = {
      header: { event_id: "evt1", event_type: "im.message.receive_v1" },
      event: { sender: { sender_type: "app" }, message: { message_type: "text", chat_id: "oc_1", content: JSON.stringify({ text: "an echo" }) } },
    };
    expect(parseFeishuPayload(body)).toEqual({ kind: "ignored" });
  });

  it("ignores a non-message event type", () => {
    expect(parseFeishuPayload({ header: { event_id: "evt1", event_type: "im.chat.updated_v1" }, event: {} })).toEqual({ kind: "ignored" });
  });

  it("ignores a non-text message (e.g. an image)", () => {
    const body = {
      header: { event_id: "evt1", event_type: "im.message.receive_v1" },
      event: { sender: { sender_type: "user" }, message: { message_type: "image", chat_id: "oc_1", content: JSON.stringify({ image_key: "x" }) } },
    };
    expect(parseFeishuPayload(body)).toEqual({ kind: "ignored" });
  });

  it("ignores a message whose content isn't valid JSON, instead of throwing", () => {
    const body = {
      header: { event_id: "evt1", event_type: "im.message.receive_v1" },
      event: { sender: { sender_type: "user" }, message: { message_type: "text", chat_id: "oc_1", content: "not json" } },
    };
    expect(parseFeishuPayload(body)).toEqual({ kind: "ignored" });
  });

  it("ignores an event missing event_id — needed for redelivery dedup, so a malformed one can't silently skip that check", () => {
    const body = {
      header: { event_type: "im.message.receive_v1" },
      event: { sender: { sender_type: "user" }, message: { message_type: "text", chat_id: "oc_1", content: JSON.stringify({ text: "hi" }) } },
    };
    expect(parseFeishuPayload(body)).toEqual({ kind: "ignored" });
  });

  it("ignores malformed/non-object input instead of throwing", () => {
    expect(parseFeishuPayload(null)).toEqual({ kind: "ignored" });
    expect(parseFeishuPayload("not an object")).toEqual({ kind: "ignored" });
  });
});
