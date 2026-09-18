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

  it("extracts an /ask command's optional image attachment option", () => {
    expect(
      parseDiscordInteraction({
        type: 2,
        channel_id: "123",
        token: "interaction-token-abc",
        data: {
          name: "ask",
          options: [
            { name: "message", type: 3, value: "what's this?" },
            { name: "image", type: 11, value: "att1" },
          ],
          resolved: { attachments: { att1: { url: "https://cdn.discordapp.com/attachments/1/2/pic.png", content_type: "image/png" } } },
        },
      }),
    ).toEqual({
      kind: "command",
      event: { channelId: "123", interactionToken: "interaction-token-abc", text: "what's this?", image: { url: "https://cdn.discordapp.com/attachments/1/2/pic.png", mimeType: "image/png" } },
    });
  });

  it("ignores an attachment option that isn't an image (e.g. a PDF)", () => {
    const result = parseDiscordInteraction({
      type: 2,
      channel_id: "123",
      token: "t",
      data: {
        name: "ask",
        options: [
          { name: "message", type: 3, value: "see attached" },
          { name: "image", type: 11, value: "att1" },
        ],
        resolved: { attachments: { att1: { url: "https://cdn.discordapp.com/attachments/1/2/doc.pdf", content_type: "application/pdf" } } },
      },
    });
    expect(result).toEqual({ kind: "command", event: { channelId: "123", interactionToken: "t", text: "see attached" } });
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

  it("extracts a message component (button tap) interaction", () => {
    expect(parseDiscordInteraction({ type: 3, channel_id: "123", data: { custom_id: "confirm_y" } })).toEqual({
      kind: "component",
      event: { channelId: "123", customId: "confirm_y" },
    });
  });

  it("ignores a malformed component interaction missing channel_id or custom_id", () => {
    expect(parseDiscordInteraction({ type: 3, data: { custom_id: "confirm_y" } })).toEqual({ kind: "ignored" });
    expect(parseDiscordInteraction({ type: 3, channel_id: "123", data: {} })).toEqual({ kind: "ignored" });
  });

  it("ignores a modal submit interaction (type 5)", () => {
    expect(parseDiscordInteraction({ type: 5, data: { custom_id: "modal1" } })).toEqual({ kind: "ignored" });
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
