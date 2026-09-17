/**
 * A parsed `m.room.message` event from a Matrix Application Service
 * transaction (https://spec.matrix.org/latest/application-service-api/#pushing-events)
 * — the AS-pushed equivalent of Telegram's webhook update / Slack's event
 * callback. `eventId` is Matrix's own globally-unique event id, used for
 * dedup the same way Telegram's `update_id` is (see update-dedup.ts) —
 * unlike Telegram, a WHOLE TRANSACTION (a batch of events, its own
 * `txnId`) can be redelivered, so a per-event id is what's actually
 * needed to dedup correctly rather than the transaction id alone.
 */
export interface MatrixMessageEvent {
  eventId: string;
  roomId: string;
  sender: string;
  text: string;
}

export type ParsedMatrixEvent = { kind: "message"; event: MatrixMessageEvent } | { kind: "ignored" };

/**
 * Only a plain `m.room.message` with `msgtype: "m.text"` from someone
 * OTHER than the bot's own user id is worth running a turn for — unlike
 * Telegram (which never echoes a bot's own sent messages back), an
 * Application Service DOES see every event in a room it's joined,
 * including its own bot's replies, so `botUserId` must be checked here
 * or every reply would trigger another turn on itself.
 */
export function parseMatrixEvent(raw: unknown, botUserId: string): ParsedMatrixEvent {
  if (typeof raw !== "object" || raw === null) return { kind: "ignored" };
  const event = raw as Record<string, unknown>;

  if (event.type !== "m.room.message") return { kind: "ignored" };
  if (typeof event.event_id !== "string") return { kind: "ignored" };
  if (typeof event.room_id !== "string") return { kind: "ignored" };
  if (typeof event.sender !== "string" || event.sender === botUserId) return { kind: "ignored" };

  const content = event.content as Record<string, unknown> | undefined;
  if (content?.msgtype !== "m.text" || typeof content.body !== "string") return { kind: "ignored" };

  return { kind: "message", event: { eventId: event.event_id, roomId: event.room_id, sender: event.sender, text: content.body } };
}

/** A transaction's real body is `{ events: [...] }` — every REAL m.room.message it contains, in order; anything else in the batch (reactions, read receipts, other event types) is silently skipped rather than causing the whole transaction to fail. */
export function parseMatrixTransaction(body: unknown, botUserId: string): MatrixMessageEvent[] {
  if (typeof body !== "object" || body === null) return [];
  const events = (body as Record<string, unknown>).events;
  if (!Array.isArray(events)) return [];
  const messages: MatrixMessageEvent[] = [];
  for (const raw of events) {
    const parsed = parseMatrixEvent(raw, botUserId);
    if (parsed.kind === "message") messages.push(parsed.event);
  }
  return messages;
}
