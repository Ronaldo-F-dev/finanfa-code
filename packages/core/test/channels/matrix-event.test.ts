import { describe, expect, it } from "vitest";
import { parseMatrixEvent, parseMatrixTransaction } from "../../src/channels/matrix-event.js";

const BOT_USER_ID = "@finanfa-bot:example.org";

describe("parseMatrixEvent", () => {
  it("extracts a plain m.room.message text event", () => {
    expect(
      parseMatrixEvent(
        { type: "m.room.message", event_id: "$evt1", room_id: "!room1:example.org", sender: "@alice:example.org", content: { msgtype: "m.text", body: "hello" } },
        BOT_USER_ID,
      ),
    ).toEqual({ kind: "message", event: { eventId: "$evt1", roomId: "!room1:example.org", sender: "@alice:example.org", text: "hello" } });
  });

  it("ignores an event sent by the bot's own user id (avoids an echo loop)", () => {
    expect(
      parseMatrixEvent(
        { type: "m.room.message", event_id: "$evt1", room_id: "!room1:example.org", sender: BOT_USER_ID, content: { msgtype: "m.text", body: "my own reply" } },
        BOT_USER_ID,
      ),
    ).toEqual({ kind: "ignored" });
  });

  it("ignores a non-message event type (e.g. m.room.member)", () => {
    expect(parseMatrixEvent({ type: "m.room.member", event_id: "$evt1", room_id: "!room1:example.org", sender: "@alice:example.org", content: {} }, BOT_USER_ID)).toEqual({
      kind: "ignored",
    });
  });

  it("ignores a non-text msgtype (e.g. m.image)", () => {
    expect(
      parseMatrixEvent(
        { type: "m.room.message", event_id: "$evt1", room_id: "!room1:example.org", sender: "@alice:example.org", content: { msgtype: "m.image", url: "mxc://x" } },
        BOT_USER_ID,
      ),
    ).toEqual({ kind: "ignored" });
  });

  it("ignores an event missing event_id/room_id — needed for dedup/reply routing, so a malformed one can't silently skip those checks", () => {
    expect(parseMatrixEvent({ type: "m.room.message", sender: "@alice:example.org", content: { msgtype: "m.text", body: "hi" } }, BOT_USER_ID)).toEqual({ kind: "ignored" });
  });

  it("ignores malformed/non-object input instead of throwing", () => {
    expect(parseMatrixEvent(null, BOT_USER_ID)).toEqual({ kind: "ignored" });
    expect(parseMatrixEvent("not an object", BOT_USER_ID)).toEqual({ kind: "ignored" });
  });
});

describe("parseMatrixTransaction", () => {
  it("extracts every real message event from a transaction's own batch, skipping non-message ones", () => {
    const body = {
      events: [
        { type: "m.room.message", event_id: "$1", room_id: "!r:example.org", sender: "@alice:example.org", content: { msgtype: "m.text", body: "first" } },
        { type: "m.room.member", event_id: "$2", room_id: "!r:example.org", sender: "@alice:example.org", content: {} },
        { type: "m.room.message", event_id: "$3", room_id: "!r:example.org", sender: BOT_USER_ID, content: { msgtype: "m.text", body: "bot's own echo" } },
        { type: "m.room.message", event_id: "$4", room_id: "!r:example.org", sender: "@bob:example.org", content: { msgtype: "m.text", body: "second" } },
      ],
    };
    const messages = parseMatrixTransaction(body, BOT_USER_ID);
    expect(messages).toEqual([
      { eventId: "$1", roomId: "!r:example.org", sender: "@alice:example.org", text: "first" },
      { eventId: "$4", roomId: "!r:example.org", sender: "@bob:example.org", text: "second" },
    ]);
  });

  it("returns an empty array for malformed/missing events instead of throwing", () => {
    expect(parseMatrixTransaction(null, BOT_USER_ID)).toEqual([]);
    expect(parseMatrixTransaction({}, BOT_USER_ID)).toEqual([]);
    expect(parseMatrixTransaction({ events: "not an array" }, BOT_USER_ID)).toEqual([]);
  });
});
