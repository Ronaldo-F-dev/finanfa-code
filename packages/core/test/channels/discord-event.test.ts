import { describe, expect, it } from "vitest";
import { parseDiscordInteraction } from "../../src/channels/discord-event.js";

describe("parseDiscordInteraction", () => {
  it("recognizes a PING (Discord's own endpoint-verification handshake)", () => {
    expect(parseDiscordInteraction({ type: 1 })).toEqual({ kind: "ping" });
  });

  it("extracts a /ask command's message option", () => {
    expect(
      parseDiscordInteraction({
        type: 2,
        channel_id: "123",
        token: "interaction-token-abc",
        data: { name: "ask", options: [{ name: "message", type: 3, value: "hello there" }] },
      }),
    ).toEqual({ kind: "command", event: { channelId: "123", interactionToken: "interaction-token-abc", text: "hello there" } });
  });

  it("ignores a command that isn't /ask", () => {
    expect(
      parseDiscordInteraction({
        type: 2,
        channel_id: "123",
        token: "t",
        data: { name: "ping", options: [] },
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("ignores a message component / modal interaction (type 3/5)", () => {
    expect(parseDiscordInteraction({ type: 3, data: { custom_id: "button1" } })).toEqual({ kind: "ignored" });
  });

  it("ignores /ask with no message option", () => {
    expect(parseDiscordInteraction({ type: 2, channel_id: "123", token: "t", data: { name: "ask", options: [] } })).toEqual({ kind: "ignored" });
  });

  it("ignores malformed/non-object input instead of throwing", () => {
    expect(parseDiscordInteraction(null)).toEqual({ kind: "ignored" });
    expect(parseDiscordInteraction("not an object")).toEqual({ kind: "ignored" });
    expect(parseDiscordInteraction({ type: 2 })).toEqual({ kind: "ignored" });
  });
});
