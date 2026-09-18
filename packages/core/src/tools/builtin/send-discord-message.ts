import type { ToolDefinition } from "../../core/types.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool, same shape as send-slack-message.ts/
// send-telegram-message.ts — posts to a Discord channel via the real REST
// API, using a bot token (Authorization: Bot ...) so it can post to any
// channel the bot has access to, not just reply to an interaction.
export interface DiscordConfig {
  botToken: string;
}

export function discordConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DiscordConfig | undefined {
  const botToken = env.DISCORD_BOT_TOKEN;
  return botToken ? { botToken } : undefined;
}

interface SendDiscordMessageInput {
  channelId: string;
  text: string;
}

interface DiscordApiErrorResponse {
  message?: string;
  code?: number;
  /** Discord's rate-limit wait, in (fractional) seconds — present in the JSON body of a 429, not a header. */
  retry_after?: number;
}

function parseDiscordRetryAfterMs(_response: Response, bodyText: string): number | undefined {
  try {
    const seconds = (JSON.parse(bodyText) as DiscordApiErrorResponse).retry_after;
    return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export type PostDiscordMessageResult = { ok: true; messageId?: string } | { ok: false; error: string };

/**
 * The raw "create message" call, shared by this tool and (for symmetry —
 * the inbound channel actually replies via patchDiscordInteractionResponse
 * below, not this) anything else that wants to proactively message a
 * channel outside of responding to an interaction.
 */
export async function postDiscordMessage(
  config: DiscordConfig,
  input: { channelId: string; text: string },
  apiBaseUrl = "https://discord.com/api/v10",
): Promise<PostDiscordMessageResult> {
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(
      `${apiBaseUrl}/channels/${input.channelId}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bot ${config.botToken}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ content: input.text }),
      },
      { retryAfterMs: parseDiscordRetryAfterMs },
    ));
  } catch (err) {
    return { ok: false, error: `Failed to reach Discord: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    let data: DiscordApiErrorResponse = {};
    try {
      data = JSON.parse(bodyText) as DiscordApiErrorResponse;
    } catch {
      // Non-JSON error body — fall through with the plain status text below.
    }
    return { ok: false, error: data.message ?? `Discord returned HTTP ${response.status}.` };
  }

  const data = JSON.parse(bodyText) as { id?: string };
  return { ok: true, messageId: data.id };
}

/**
 * Completes a deferred slash-command response (see channels-discord.ts in
 * @finanfa/web-server): a /ask interaction is ack'd immediately with a
 * "thinking" placeholder (type 5), since a real agent turn takes far
 * longer than Discord's 3-second interaction-response window, then this
 * PATCHes the placeholder with the real reply once the turn finishes.
 * Authenticated by the interaction token itself — no bot token needed.
 */
export async function patchDiscordInteractionResponse(
  applicationId: string,
  interactionToken: string,
  text: string,
  apiBaseUrl = "https://discord.com/api/v10",
): Promise<PostDiscordMessageResult> {
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(
      `${apiBaseUrl}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ content: text }),
      },
      { retryAfterMs: parseDiscordRetryAfterMs },
    ));
  } catch (err) {
    return { ok: false, error: `Failed to reach Discord: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    let data: DiscordApiErrorResponse = {};
    try {
      data = JSON.parse(bodyText) as DiscordApiErrorResponse;
    } catch {
      // Non-JSON error body — fall through with the plain status text below.
    }
    return { ok: false, error: data.message ?? `Discord returned HTTP ${response.status}.` };
  }
  return { ok: true };
}

export interface DiscordButton {
  label: string;
  /** Echoed back verbatim on the resulting message_component interaction (see discord-event.ts) — this project uses it as the answer itself, e.g. "confirm_y". */
  customId: string;
  /** Discord's button styles: 1 primary, 2 secondary, 3 success, 4 danger. Defaults to secondary. */
  style?: 1 | 2 | 3 | 4;
}

/**
 * Posts a *new* message on an interaction's webhook (as opposed to
 * patchDiscordInteractionResponse, which edits the original deferred
 * reply) — valid for ~15 minutes after the triggering interaction, no bot
 * token needed. Used to send a real, mid-turn permission-confirmation
 * question with tappable buttons (see channels-discord.ts), separate from
 * the turn's own final reply.
 */
export async function sendDiscordFollowupMessage(
  applicationId: string,
  interactionToken: string,
  text: string,
  buttons?: DiscordButton[],
  apiBaseUrl = "https://discord.com/api/v10",
): Promise<PostDiscordMessageResult> {
  const components = buttons?.length ? [{ type: 1, components: buttons.map((b) => ({ type: 2, style: b.style ?? 2, label: b.label, custom_id: b.customId })) }] : undefined;
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(
      `${apiBaseUrl}/webhooks/${applicationId}/${interactionToken}`,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ content: text, components }),
      },
      { retryAfterMs: parseDiscordRetryAfterMs },
    ));
  } catch (err) {
    return { ok: false, error: `Failed to reach Discord: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    let data: DiscordApiErrorResponse = {};
    try {
      data = JSON.parse(bodyText) as DiscordApiErrorResponse;
    } catch {
      // Non-JSON error body — fall through with the plain status text below.
    }
    return { ok: false, error: data.message ?? `Discord returned HTTP ${response.status}.` };
  }
  const data = JSON.parse(bodyText) as { id?: string };
  return { ok: true, messageId: data.id };
}

export function createSendDiscordMessageTool(config: DiscordConfig | undefined, apiBaseUrl = "https://discord.com/api/v10"): ToolDefinition<SendDiscordMessageInput> {
  return {
    name: "send_discord_message",
    description:
      "Send a real message to a Discord channel via the REST API. Requires DISCORD_BOT_TOKEN to be configured " +
      "as an environment variable (a bot invited to the target server with the Send Messages permission) — " +
      "this tool never takes credentials as input. IMPORTANT: this posts a real, visible message to a real " +
      "channel — confirm the channel/content with the user before calling this unless they've explicitly asked " +
      "for this exact message.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "Discord channel id" },
        text: { type: "string", description: "Message text" },
      },
      required: ["channelId", "text"],
    },
    describeCall: (input) => `send Discord message to channel ${input.channelId}: "${input.text.slice(0, 60)}"`,
    async handler(input) {
      if (!config) {
        return { content: "Discord is not configured — set DISCORD_BOT_TOKEN as an environment variable to enable send_discord_message.", isError: true };
      }
      const result = await postDiscordMessage(config, input, apiBaseUrl);
      if (!result.ok) {
        return { content: result.error, isError: true };
      }
      return { content: `Message sent to channel ${input.channelId}${result.messageId ? ` (message id: ${result.messageId})` : ""}.`, isError: false };
    },
  };
}
