export interface WhatsappMessageEvent {
  /** The sender's WhatsApp phone number (E.164 digits, no "+") — also the id used to reply. */
  from: string;
  messageId: string;
  text: string;
}

export type ParsedWhatsappPayload = { kind: "message"; event: WhatsappMessageEvent } | { kind: "ignored" };

/**
 * WhatsApp Cloud API's webhook payload wraps a real message in several
 * layers of envelope (object → entry[] → changes[] → value.messages[]),
 * and fires the same webhook for status updates (sent/delivered/read
 * receipts) that aren't a message to reply to at all — this is the one
 * place that decides what's actually worth running a turn for. Only a
 * plain text message is handled; media/location/interactive-reply
 * messages are ignored for now, same scope boundary Slack/Telegram/
 * Discord's own inbound parsing started with.
 */
export function parseWhatsappPayload(body: unknown): ParsedWhatsappPayload {
  if (typeof body !== "object" || body === null) return { kind: "ignored" };
  const top = body as Record<string, unknown>;
  if (top.object !== "whatsapp_business_account") return { kind: "ignored" };

  const entries = Array.isArray(top.entry) ? (top.entry as Record<string, unknown>[]) : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? (entry.changes as Record<string, unknown>[]) : [];
    for (const change of changes) {
      if (change.field !== "messages") continue;
      const value = change.value as Record<string, unknown> | undefined;
      const messages = Array.isArray(value?.messages) ? (value?.messages as Record<string, unknown>[]) : [];
      for (const message of messages) {
        if (message.type !== "text") continue;
        const text = (message.text as Record<string, unknown> | undefined)?.body;
        if (typeof message.from !== "string" || typeof message.id !== "string" || typeof text !== "string") continue;
        return { kind: "message", event: { from: message.from, messageId: message.id, text } };
      }
    }
  }
  return { kind: "ignored" };
}

export interface WhatsappVerificationQuery {
  mode?: string;
  verifyToken?: string;
  challenge?: string;
}

/**
 * Meta's own one-time endpoint-verification handshake (`GET
 * /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`),
 * separate from the signed POST events above — Meta refuses to save the
 * webhook URL in the app dashboard until this succeeds. Returns the raw
 * challenge string to echo back verbatim on success, or undefined when
 * the token doesn't match (the caller should 403 instead).
 */
export function verifyWhatsappWebhookHandshake(query: WhatsappVerificationQuery, expectedVerifyToken: string): string | undefined {
  if (query.mode !== "subscribe") return undefined;
  if (query.verifyToken !== expectedVerifyToken) return undefined;
  return query.challenge;
}
