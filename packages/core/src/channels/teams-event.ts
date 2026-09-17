export interface TeamsMessageEvent {
  /** Bot Framework's own activity id — redelivered unchanged on a retry (see update-dedup.ts). */
  activityId: string;
  /** Where to POST a reply — differs per region/tenant, unlike a fixed API base URL, so it has to come from the inbound activity itself, not a constant. */
  serviceUrl: string;
  conversationId: string;
  text: string;
}

export type ParsedTeamsActivity = { kind: "message"; event: TeamsMessageEvent } | { kind: "ignored" };

/**
 * Only a real `message` Activity with actual text is worth running a
 * turn for — Bot Framework has other activity types entirely
 * (conversationUpdate for member-added/removed, typing, ...) that this
 * webhook also receives. `recipient.id` (the bot's own id on this
 * activity) vs `from.id` isn't checked defensively the way Telegram's
 * `is_bot` is — Bot Framework's own conversation model doesn't echo the
 * bot's own sent replies back as a new inbound activity in the first
 * place, unlike Slack.
 */
export function parseTeamsActivity(body: unknown): ParsedTeamsActivity {
  if (typeof body !== "object" || body === null) return { kind: "ignored" };
  const activity = body as Record<string, unknown>;

  if (activity.type !== "message") return { kind: "ignored" };
  if (typeof activity.id !== "string") return { kind: "ignored" };
  if (typeof activity.serviceUrl !== "string") return { kind: "ignored" };
  if (typeof activity.text !== "string" || activity.text.trim() === "") return { kind: "ignored" };

  const conversation = activity.conversation as Record<string, unknown> | undefined;
  if (typeof conversation?.id !== "string") return { kind: "ignored" };

  return { kind: "message", event: { activityId: activity.id, serviceUrl: activity.serviceUrl, conversationId: conversation.id, text: activity.text } };
}
