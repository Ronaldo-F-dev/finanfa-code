export interface SlackImageAttachment {
  /** Requires Authorization: Bearer <bot token> to actually fetch — Slack file URLs aren't public (see slack-file.ts). */
  url: string;
  mimeType: string;
}

export interface SlackMessageEvent {
  channel: string;
  /** thread_ts if this message is already in a thread, else its own ts — the key used to map a Slack conversation to one AgentSession (see headless-turn.ts). */
  threadKey: string;
  text: string;
  user?: string;
  images?: SlackImageAttachment[];
}

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export type ParsedSlackPayload =
  | { kind: "url_verification"; challenge: string }
  | { kind: "message"; event: SlackMessageEvent }
  | { kind: "ignored" };

/**
 * Slack's Events API wraps a real user message in a fair amount of
 * envelope, and fires the same webhook for things that aren't a message
 * to reply to at all (the bot's own posts echoed back, edits/deletes,
 * channel-join notices, ...). This is the one place that decides what's
 * actually worth running a turn for.
 */
export function parseSlackPayload(body: unknown): ParsedSlackPayload {
  if (typeof body !== "object" || body === null) return { kind: "ignored" };
  const top = body as Record<string, unknown>;

  if (top.type === "url_verification" && typeof top.challenge === "string") {
    return { kind: "url_verification", challenge: top.challenge };
  }

  if (top.type !== "event_callback" || typeof top.event !== "object" || top.event === null) {
    return { kind: "ignored" };
  }
  const event = top.event as Record<string, unknown>;

  // Only a plain message or an @-mention — not a "subtype" event
  // (message_changed, message_deleted, channel_join, ...), and never the
  // bot's own message (bot_id set), which would otherwise have it reply
  // to itself forever. "file_share" is the one subtype let through: it's
  // a real new message that happens to carry an attachment, not an edit/
  // delete/join notice.
  if (event.type !== "message" && event.type !== "app_mention") return { kind: "ignored" };
  if (event.bot_id) return { kind: "ignored" };
  if (event.subtype && event.subtype !== "file_share") return { kind: "ignored" };
  if (typeof event.text !== "string" || typeof event.channel !== "string" || typeof event.ts !== "string") {
    return { kind: "ignored" };
  }

  const images = Array.isArray(event.files)
    ? event.files
        .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
        .filter((f) => typeof f.mimetype === "string" && IMAGE_MIME_TYPES.has(f.mimetype) && typeof f.url_private === "string")
        .map((f) => ({ url: f.url_private as string, mimeType: f.mimetype as string }))
    : [];

  return {
    kind: "message",
    event: {
      channel: event.channel,
      threadKey: typeof event.thread_ts === "string" ? event.thread_ts : event.ts,
      text: event.text,
      user: typeof event.user === "string" ? event.user : undefined,
      images: images.length > 0 ? images : undefined,
    },
  };
}
