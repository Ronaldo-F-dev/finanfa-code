/** The Verification Token Feishu embeds IN the event body itself — `header.token` on a real event (schema 2.0), or a top-level `token` on the one-time url_verification challenge (sent before the app's event schema version is even negotiated). Extracted separately from parsing so the route handler can verify it BEFORE trusting anything else in the body, same "verify first" order as every other channel here. */
export function extractFeishuToken(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const top = body as Record<string, unknown>;
  if (typeof top.token === "string") return top.token;
  const header = top.header as Record<string, unknown> | undefined;
  return typeof header?.token === "string" ? header.token : undefined;
}

export interface FeishuMessageEvent {
  /** header.event_id — redelivered unchanged on a retry (see update-dedup.ts). */
  eventId: string;
  chatId: string;
  text: string;
}

export type ParsedFeishuPayload =
  | { kind: "url_verification"; challenge: string }
  | { kind: "message"; event: FeishuMessageEvent }
  | { kind: "ignored" };

/**
 * Feishu's own event envelope (schema 2.0): a real `im.message.receive_v1`
 * event is the only kind worth running a turn for — `event.message.content`
 * is itself a JSON-encoded STRING (not a nested object), whose shape
 * depends on message_type; only `text` is handled here (an image/file/
 * sticker message is ignored, same "text only, for now" scope
 * transcribe_audio-less channels already have). Defensively skips a
 * message from the bot's own sender_type ("app"), even though Feishu
 * doesn't normally echo a bot's own sent messages back as receive
 * events — the same belt-and-suspenders check Telegram's own
 * parser makes for an unexpected `from.is_bot`.
 */
export function parseFeishuPayload(body: unknown): ParsedFeishuPayload {
  if (typeof body !== "object" || body === null) return { kind: "ignored" };
  const top = body as Record<string, unknown>;

  if (top.type === "url_verification" && typeof top.challenge === "string") {
    return { kind: "url_verification", challenge: top.challenge };
  }

  const header = top.header as Record<string, unknown> | undefined;
  if (header?.event_type !== "im.message.receive_v1") return { kind: "ignored" };
  if (typeof header.event_id !== "string") return { kind: "ignored" };

  const event = top.event as Record<string, unknown> | undefined;
  const sender = event?.sender as Record<string, unknown> | undefined;
  if (sender?.sender_type === "app") return { kind: "ignored" };

  const message = event?.message as Record<string, unknown> | undefined;
  if (message?.message_type !== "text" || typeof message.content !== "string" || typeof message.chat_id !== "string") {
    return { kind: "ignored" };
  }

  let text: string;
  try {
    const content = JSON.parse(message.content) as { text?: string };
    if (typeof content.text !== "string") return { kind: "ignored" };
    text = content.text;
  } catch {
    return { kind: "ignored" };
  }

  return { kind: "message", event: { eventId: header.event_id, chatId: message.chat_id, text } };
}
