export interface LineMessageEvent {
  /** LINE's own delivery id for this one event — redelivered unchanged on a retry (see update-dedup.ts). */
  webhookEventId: string;
  /** The user/group/room id to reply to via the push API (see send-line-message.ts) — whichever kind of chat this came from, they all work identically as a `to` target. */
  targetId: string;
  text: string;
}

export type ParsedLineEvent = { kind: "message"; event: LineMessageEvent } | { kind: "ignored" };

/** LINE's own source object names the id field differently per chat kind (userId/groupId/roomId) — this is the one place that picks the right one, so callers don't need to know which kind of chat a message came from. */
function targetIdFromSource(source: Record<string, unknown> | undefined): string | undefined {
  if (!source) return undefined;
  if (source.type === "user" && typeof source.userId === "string") return source.userId;
  if (source.type === "group" && typeof source.groupId === "string") return source.groupId;
  if (source.type === "room" && typeof source.roomId === "string") return source.roomId;
  return undefined;
}

function parseLineEvent(raw: unknown): ParsedLineEvent {
  if (typeof raw !== "object" || raw === null) return { kind: "ignored" };
  const event = raw as Record<string, unknown>;

  // Only a real inbound text message — "message" is also fired for
  // images/stickers/location/etc (not handled here), and LINE has other
  // top-level event types entirely (follow/unfollow/join/leave/postback)
  // that aren't a message to reply to at all.
  if (event.type !== "message") return { kind: "ignored" };
  if (typeof event.webhookEventId !== "string") return { kind: "ignored" };

  const message = event.message as Record<string, unknown> | undefined;
  if (message?.type !== "text" || typeof message.text !== "string") return { kind: "ignored" };

  const targetId = targetIdFromSource(event.source as Record<string, unknown> | undefined);
  if (!targetId) return { kind: "ignored" };

  return { kind: "message", event: { webhookEventId: event.webhookEventId, targetId, text: message.text } };
}

/** A webhook call's real body is `{ destination, events: [...] }` — every real text message it contains, in order; anything else in the batch (non-text messages, follow/join notices, ...) is silently skipped. */
export function parseLineWebhookBody(body: unknown): LineMessageEvent[] {
  if (typeof body !== "object" || body === null) return [];
  const events = (body as Record<string, unknown>).events;
  if (!Array.isArray(events)) return [];
  const messages: LineMessageEvent[] = [];
  for (const raw of events) {
    const parsed = parseLineEvent(raw);
    if (parsed.kind === "message") messages.push(parsed.event);
  }
  return messages;
}
