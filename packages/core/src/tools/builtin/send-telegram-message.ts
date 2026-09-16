import type { ToolDefinition } from "../../core/types.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool, same shape as send-slack-message.ts — posts to
// Telegram via the real Bot API (sendMessage). The bot token lives in the
// URL path itself (Telegram's own convention, unlike Slack's Bearer
// header), never in tool input.
export interface TelegramConfig {
  botToken: string;
}

export function telegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | undefined {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  return botToken ? { botToken } : undefined;
}

interface SendTelegramMessageInput {
  chatId: string;
  text: string;
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: { message_id: number };
  parameters?: { retry_after?: number };
}

export type PostTelegramMessageResult = { ok: true; messageId?: number } | { ok: false; error: string };

/**
 * The raw sendMessage call, shared by this tool and the inbound Telegram
 * channel webhook (see @finanfa/web-server's channels-telegram.ts) so
 * neither duplicates Telegram's URL shape/error handling.
 */
export async function postTelegramMessage(
  config: TelegramConfig,
  input: { chatId: string; text: string; replyToMessageId?: number; messageThreadId?: number },
  apiBaseUrl = "https://api.telegram.org",
): Promise<PostTelegramMessageResult> {
  let response: Response;
  let bodyText: string;
  try {
    // Telegram reports its rate-limit wait inside the JSON error body
    // (parameters.retry_after, in seconds), not a header — read there
    // instead of guessing at a generic backoff delay.
    ({ response, bodyText } = await fetchWithRetry(
      `${apiBaseUrl}/bot${config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          chat_id: input.chatId,
          text: input.text,
          reply_to_message_id: input.replyToMessageId,
          message_thread_id: input.messageThreadId,
        }),
      },
      { retryAfterMs: (_response, body) => parseRetryAfterMs(body) },
    ));
  } catch (err) {
    return { ok: false, error: `Failed to reach Telegram: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: TelegramApiResponse;
  try {
    data = JSON.parse(bodyText) as TelegramApiResponse;
  } catch {
    return { ok: false, error: `Telegram returned an unparseable response (HTTP ${response.status}).` };
  }

  return data.ok ? { ok: true, messageId: data.result?.message_id } : { ok: false, error: data.description ?? "unknown error" };
}

function parseRetryAfterMs(bodyText: string): number | undefined {
  try {
    const seconds = (JSON.parse(bodyText) as TelegramApiResponse).parameters?.retry_after;
    return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function createSendTelegramMessageTool(config: TelegramConfig | undefined, apiBaseUrl = "https://api.telegram.org"): ToolDefinition<SendTelegramMessageInput> {
  return {
    name: "send_telegram_message",
    description:
      "Send a real message to a Telegram chat via the Bot API (sendMessage). Requires TELEGRAM_BOT_TOKEN to be " +
      "configured as an environment variable — this tool never takes credentials as input. IMPORTANT: this " +
      "posts a real, visible message to a real chat — confirm the chat/content with the user before calling " +
      "this unless they've explicitly asked for this exact message.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "Telegram chat id (numeric, as a string) or @channelusername" },
        text: { type: "string", description: "Message text" },
      },
      required: ["chatId", "text"],
    },
    describeCall: (input) => `send Telegram message to ${input.chatId}: "${input.text.slice(0, 60)}"`,
    async handler(input) {
      if (!config) {
        return { content: "Telegram is not configured — set TELEGRAM_BOT_TOKEN as an environment variable to enable send_telegram_message.", isError: true };
      }
      const result = await postTelegramMessage(config, input, apiBaseUrl);
      if (!result.ok) {
        return { content: result.error, isError: true };
      }
      return { content: `Message sent to ${input.chatId}${result.messageId ? ` (message_id: ${result.messageId})` : ""}.`, isError: false };
    },
  };
}
