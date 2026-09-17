import { describe, expect, it } from "vitest";
import { parseWhatsappPayload, verifyWhatsappWebhookHandshake } from "../../src/channels/whatsapp-event.js";

describe("parseWhatsappPayload", () => {
  function payloadWithMessage(message: Record<string, unknown>): unknown {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "entry1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "123" },
                messages: [message],
              },
            },
          ],
        },
      ],
    };
  }

  it("extracts a plain text message", () => {
    const result = parseWhatsappPayload(
      payloadWithMessage({ from: "15551234567", id: "wamid.abc", timestamp: "1700000000", type: "text", text: { body: "hello" } }),
    );
    expect(result).toEqual({ kind: "message", event: { from: "15551234567", messageId: "wamid.abc", text: "hello" } });
  });

  it("ignores a non-text message (e.g. an image)", () => {
    const result = parseWhatsappPayload(payloadWithMessage({ from: "15551234567", id: "wamid.abc", type: "image", image: { id: "media1" } }));
    expect(result).toEqual({ kind: "ignored" });
  });

  it("ignores a status-update webhook (delivered/read receipts) — no messages field at all", () => {
    const result = parseWhatsappPayload({
      object: "whatsapp_business_account",
      entry: [{ id: "entry1", changes: [{ field: "messages", value: { statuses: [{ id: "wamid.abc", status: "delivered" }] } }] }],
    });
    expect(result).toEqual({ kind: "ignored" });
  });

  it("ignores an update for a field other than 'messages'", () => {
    const result = parseWhatsappPayload({
      object: "whatsapp_business_account",
      entry: [{ id: "entry1", changes: [{ field: "message_template_status_update", value: {} }] }],
    });
    expect(result).toEqual({ kind: "ignored" });
  });

  it("ignores a payload for a different object type", () => {
    expect(parseWhatsappPayload({ object: "page", entry: [] })).toEqual({ kind: "ignored" });
  });

  it("ignores malformed/non-object input instead of throwing", () => {
    expect(parseWhatsappPayload(null)).toEqual({ kind: "ignored" });
    expect(parseWhatsappPayload("not an object")).toEqual({ kind: "ignored" });
    expect(parseWhatsappPayload({ object: "whatsapp_business_account" })).toEqual({ kind: "ignored" });
  });
});

describe("verifyWhatsappWebhookHandshake", () => {
  it("returns the challenge when mode and verify_token are correct", () => {
    const result = verifyWhatsappWebhookHandshake({ mode: "subscribe", verifyToken: "secret", challenge: "12345" }, "secret");
    expect(result).toBe("12345");
  });

  it("returns undefined when the verify_token doesn't match", () => {
    const result = verifyWhatsappWebhookHandshake({ mode: "subscribe", verifyToken: "wrong", challenge: "12345" }, "secret");
    expect(result).toBeUndefined();
  });

  it("returns undefined when mode isn't 'subscribe'", () => {
    const result = verifyWhatsappWebhookHandshake({ mode: "unsubscribe", verifyToken: "secret", challenge: "12345" }, "secret");
    expect(result).toBeUndefined();
  });
});
