import { describe, expect, it } from "vitest";
import { parseSlackPayload } from "../../src/channels/slack-event.js";

describe("parseSlackPayload", () => {
  it("recognizes the url_verification handshake", () => {
    expect(parseSlackPayload({ type: "url_verification", challenge: "abc123" })).toEqual({
      kind: "url_verification",
      challenge: "abc123",
    });
  });

  it("extracts a plain message event, keyed by its own ts when there's no thread yet", () => {
    expect(
      parseSlackPayload({
        type: "event_callback",
        event: { type: "message", channel: "C123", ts: "1700000000.000001", text: "hello", user: "U1" },
      }),
    ).toEqual({ kind: "message", event: { channel: "C123", threadKey: "1700000000.000001", text: "hello", user: "U1" } });
  });

  it("keys a threaded reply by thread_ts, not its own ts", () => {
    expect(
      parseSlackPayload({
        type: "event_callback",
        event: { type: "message", channel: "C123", ts: "1700000005.000002", thread_ts: "1700000000.000001", text: "follow-up" },
      }),
    ).toEqual({ kind: "message", event: { channel: "C123", threadKey: "1700000000.000001", text: "follow-up", user: undefined } });
  });

  it("extracts an app_mention the same way as a plain message", () => {
    expect(
      parseSlackPayload({
        type: "event_callback",
        event: { type: "app_mention", channel: "C123", ts: "1700000000.000001", text: "<@BOT> hi" },
      }).kind,
    ).toBe("message");
  });

  it("ignores the bot's own message (bot_id set) — otherwise it would reply to itself forever", () => {
    expect(
      parseSlackPayload({
        type: "event_callback",
        event: { type: "message", channel: "C123", ts: "1700000000.000001", text: "a reply", bot_id: "B1" },
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("ignores a subtype event (edit/delete/join), not a real new message", () => {
    expect(
      parseSlackPayload({
        type: "event_callback",
        event: { type: "message", channel: "C123", ts: "1700000000.000001", text: "edited", subtype: "message_changed" },
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("extracts an image attachment from a file_share message", () => {
    expect(
      parseSlackPayload({
        type: "event_callback",
        event: {
          type: "message",
          subtype: "file_share",
          channel: "C123",
          ts: "1700000000.000001",
          text: "what's this?",
          files: [{ mimetype: "image/png", url_private: "https://files.slack.com/f1.png" }],
        },
      }),
    ).toEqual({
      kind: "message",
      event: { channel: "C123", threadKey: "1700000000.000001", text: "what's this?", user: undefined, images: [{ url: "https://files.slack.com/f1.png", mimeType: "image/png" }] },
    });
  });

  it("ignores a file_share attachment that isn't an image (e.g. a PDF) but still runs the turn on its text", () => {
    const result = parseSlackPayload({
      type: "event_callback",
      event: {
        type: "message",
        subtype: "file_share",
        channel: "C123",
        ts: "1700000000.000001",
        text: "see attached",
        files: [{ mimetype: "application/pdf", url_private: "https://files.slack.com/f1.pdf" }],
      },
    });
    expect(result).toEqual({ kind: "message", event: { channel: "C123", threadKey: "1700000000.000001", text: "see attached", user: undefined } });
  });

  it("still ignores a non-file_share subtype (edit/delete/join)", () => {
    expect(
      parseSlackPayload({
        type: "event_callback",
        event: { type: "message", channel: "C123", ts: "1700000000.000001", text: "edited", subtype: "message_changed", files: [{ mimetype: "image/png", url_private: "x" }] },
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("ignores an unrelated event type", () => {
    expect(parseSlackPayload({ type: "event_callback", event: { type: "reaction_added" } })).toEqual({ kind: "ignored" });
  });

  it("ignores malformed/non-object input instead of throwing", () => {
    expect(parseSlackPayload(null)).toEqual({ kind: "ignored" });
    expect(parseSlackPayload("not an object")).toEqual({ kind: "ignored" });
    expect(parseSlackPayload({ type: "event_callback" })).toEqual({ kind: "ignored" });
  });
});
