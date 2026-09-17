import { describe, expect, it } from "vitest";
import { parseLineWebhookBody } from "../../src/channels/line-event.js";

describe("parseLineWebhookBody", () => {
  it("extracts a plain text message from a user", () => {
    const body = {
      destination: "xxx",
      events: [
        {
          type: "message",
          webhookEventId: "evt-1",
          source: { type: "user", userId: "U123" },
          message: { type: "text", id: "m1", text: "hello" },
        },
      ],
    };
    expect(parseLineWebhookBody(body)).toEqual([{ webhookEventId: "evt-1", targetId: "U123", text: "hello" }]);
  });

  it("resolves the target id correctly for a group or room source", () => {
    const groupBody = { events: [{ type: "message", webhookEventId: "e1", source: { type: "group", groupId: "G1" }, message: { type: "text", text: "hi group" } }] };
    expect(parseLineWebhookBody(groupBody)).toEqual([{ webhookEventId: "e1", targetId: "G1", text: "hi group" }]);

    const roomBody = { events: [{ type: "message", webhookEventId: "e2", source: { type: "room", roomId: "R1" }, message: { type: "text", text: "hi room" } }] };
    expect(parseLineWebhookBody(roomBody)).toEqual([{ webhookEventId: "e2", targetId: "R1", text: "hi room" }]);
  });

  it("skips a non-text message (e.g. a sticker or image)", () => {
    const body = { events: [{ type: "message", webhookEventId: "e1", source: { type: "user", userId: "U1" }, message: { type: "sticker", packageId: "1", stickerId: "2" } }] };
    expect(parseLineWebhookBody(body)).toEqual([]);
  });

  it("skips a non-message event type (e.g. follow/unfollow)", () => {
    const body = { events: [{ type: "follow", webhookEventId: "e1", source: { type: "user", userId: "U1" } }] };
    expect(parseLineWebhookBody(body)).toEqual([]);
  });

  it("extracts every real message from a multi-event batch, skipping the rest", () => {
    const body = {
      events: [
        { type: "message", webhookEventId: "e1", source: { type: "user", userId: "U1" }, message: { type: "text", text: "first" } },
        { type: "follow", webhookEventId: "e2", source: { type: "user", userId: "U2" } },
        { type: "message", webhookEventId: "e3", source: { type: "user", userId: "U3" }, message: { type: "text", text: "second" } },
      ],
    };
    expect(parseLineWebhookBody(body)).toEqual([
      { webhookEventId: "e1", targetId: "U1", text: "first" },
      { webhookEventId: "e3", targetId: "U3", text: "second" },
    ]);
  });

  it("returns an empty array for malformed/missing events instead of throwing", () => {
    expect(parseLineWebhookBody(null)).toEqual([]);
    expect(parseLineWebhookBody({})).toEqual([]);
    expect(parseLineWebhookBody({ events: "not an array" })).toEqual([]);
  });
});
