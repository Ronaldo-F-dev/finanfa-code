import { describe, expect, it } from "vitest";
import { parseTeamsActivity } from "../../src/channels/teams-event.js";

describe("parseTeamsActivity", () => {
  it("extracts a real message activity", () => {
    const body = {
      type: "message",
      id: "activity-1",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      conversation: { id: "conv-1" },
      text: "hello",
    };
    expect(parseTeamsActivity(body)).toEqual({
      kind: "message",
      event: { activityId: "activity-1", serviceUrl: "https://smba.trafficmanager.net/amer/", conversationId: "conv-1", text: "hello" },
    });
  });

  it("ignores a non-message activity type (e.g. conversationUpdate)", () => {
    const body = { type: "conversationUpdate", id: "a1", serviceUrl: "https://x", conversation: { id: "c1" } };
    expect(parseTeamsActivity(body)).toEqual({ kind: "ignored" });
  });

  it("ignores a message activity with empty/whitespace-only text", () => {
    const body = { type: "message", id: "a1", serviceUrl: "https://x", conversation: { id: "c1" }, text: "   " };
    expect(parseTeamsActivity(body)).toEqual({ kind: "ignored" });
  });

  it("ignores an activity missing id/serviceUrl/conversation.id — needed for dedup/reply routing", () => {
    expect(parseTeamsActivity({ type: "message", serviceUrl: "https://x", conversation: { id: "c1" }, text: "hi" })).toEqual({ kind: "ignored" });
    expect(parseTeamsActivity({ type: "message", id: "a1", conversation: { id: "c1" }, text: "hi" })).toEqual({ kind: "ignored" });
    expect(parseTeamsActivity({ type: "message", id: "a1", serviceUrl: "https://x", text: "hi" })).toEqual({ kind: "ignored" });
  });

  it("ignores malformed/non-object input instead of throwing", () => {
    expect(parseTeamsActivity(null)).toEqual({ kind: "ignored" });
    expect(parseTeamsActivity("not an object")).toEqual({ kind: "ignored" });
  });
});
