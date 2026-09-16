export interface DiscordCommandEvent {
  channelId: string;
  /** Authenticates the deferred-response PATCH (see headless-turn.ts's caller in web-server) — not a bot token, valid ~15 minutes. */
  interactionToken: string;
  text: string;
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
    event: { channelId: interaction.channel_id, interactionToken: interaction.token, text: messageOption.value },
  };
}
