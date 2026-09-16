export interface DiscordImageAttachment {
  /** Discord's CDN attachment URLs are public (unlike Slack/Telegram) — no bot token needed to download. */
  url: string;
  mimeType: string;
}

export interface DiscordCommandEvent {
  channelId: string;
  /** Authenticates the deferred-response PATCH (see headless-turn.ts's caller in web-server) — not a bot token, valid ~15 minutes. */
  interactionToken: string;
  text: string;
  image?: DiscordImageAttachment;
}

export type ParsedDiscordInteraction =
  | { kind: "ping" }
  | { kind: "command"; event: DiscordCommandEvent }
  | { kind: "ignored" };

/**
 * Discord interactions cover slash commands, buttons, modals, and
 * autocomplete — this project only registers one slash command, `/ask`,
 * so anything else (a different command name, a message component, ...)
 * is ignored. `type: 1` (PING) is Discord's own endpoint-verification
 * handshake, answered the same way every time this app's Interactions
 * Endpoint URL is (re)saved in the Discord dashboard.
 */
export function parseDiscordInteraction(body: unknown): ParsedDiscordInteraction {
  if (typeof body !== "object" || body === null) return { kind: "ignored" };
  const interaction = body as Record<string, unknown>;

  if (interaction.type === 1) return { kind: "ping" };
  if (interaction.type !== 2) return { kind: "ignored" };

  const data = interaction.data as Record<string, unknown> | undefined;
  if (data?.name !== "ask") return { kind: "ignored" };
  if (typeof interaction.channel_id !== "string" || typeof interaction.token !== "string") return { kind: "ignored" };

  const options = Array.isArray(data.options) ? (data.options as Record<string, unknown>[]) : [];
  const messageOption = options.find((o) => o.name === "message");
  if (typeof messageOption?.value !== "string") return { kind: "ignored" };

  return {
    kind: "command",
    event: { channelId: interaction.channel_id, interactionToken: interaction.token, text: messageOption.value, image: extractImageOption(data, options) },
  };
}

/**
 * `/ask`'s optional `image` option (attachment type, 11 — see the README's
 * command-registration curl) carries only the attachment's snowflake id;
 * the actual url/content_type live in `data.resolved.attachments`, keyed
 * by that same id — one extra level of indirection Discord's attachment
 * options always require.
 */
function extractImageOption(data: Record<string, unknown>, options: Record<string, unknown>[]): DiscordImageAttachment | undefined {
  const imageOption = options.find((o) => o.name === "image");
  if (typeof imageOption?.value !== "string") return undefined;

  const resolved = data.resolved as Record<string, unknown> | undefined;
  const attachments = resolved?.attachments as Record<string, unknown> | undefined;
  const attachment = attachments?.[imageOption.value] as Record<string, unknown> | undefined;
  if (typeof attachment?.url !== "string" || typeof attachment.content_type !== "string" || !attachment.content_type.startsWith("image/")) {
    return undefined;
  }
  return { url: attachment.url, mimeType: attachment.content_type };
}
