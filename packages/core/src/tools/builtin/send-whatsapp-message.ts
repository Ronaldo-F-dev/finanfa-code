import type { ToolDefinition } from "../../core/types.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool, same shape as send-telegram-message.ts/
// send-slack-message.ts — posts via the real WhatsApp Cloud API (Meta's
// Graph API), authenticated with a bot-scoped access token, so it can
// message any number the phone-number-id has been given permission to
// contact rather than being locked to whatever number is already in a
// conversation.
export interface WhatsappConfig {
  accessToken: string;
  phoneNumberId: string;
}

export function whatsappConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WhatsappConfig | undefined {
  const accessToken = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  return accessToken && phoneNumberId ? { accessToken, phoneNumberId } : undefined;
}

interface SendWhatsappMessageInput {
  to: string;
  text: string;
}

interface WhatsappApiErrorResponse {
  error?: { message?: string; code?: number };
}

interface WhatsappApiSuccessResponse {
  messages?: { id: string }[];
}

export type PostWhatsappMessageResult = { ok: true; messageId?: string } | { ok: false; error: string };

/**
 * The raw "send message" call, shared by this tool and (were an inbound
 * channel ever to reply proactively outside a webhook handler) anything
 * else that wants to message a WhatsApp number.
 */
export async function postWhatsappMessage(
  config: WhatsappConfig,
  input: { to: string; text: string },
  apiBaseUrl = "https://graph.facebook.com/v20.0",
): Promise<PostWhatsappMessageResult> {
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(
      `${apiBaseUrl}/${config.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${config.accessToken}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: input.to, type: "text", text: { body: input.text } }),
      },
      { retryAfterMs: parseRetryAfterHeaderMs },
    ));
  } catch (err) {
    return { ok: false, error: `Failed to reach WhatsApp: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    let data: WhatsappApiErrorResponse = {};
    try {
      data = JSON.parse(bodyText) as WhatsappApiErrorResponse;
    } catch {
      // Non-JSON error body — fall through with the plain status text below.
    }
    return { ok: false, error: data.error?.message ?? `WhatsApp returned HTTP ${response.status}.` };
  }

  const data = JSON.parse(bodyText) as WhatsappApiSuccessResponse;
  return { ok: true, messageId: data.messages?.[0]?.id };
}

function parseRetryAfterHeaderMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export function createSendWhatsappMessageTool(config: WhatsappConfig | undefined, apiBaseUrl = "https://graph.facebook.com/v20.0"): ToolDefinition<SendWhatsappMessageInput> {
  return {
    name: "send_whatsapp_message",
    description:
      "Send a real WhatsApp message via the WhatsApp Cloud API. Requires WHATSAPP_ACCESS_TOKEN and " +
      "WHATSAPP_PHONE_NUMBER_ID to be configured as environment variables — this tool never takes credentials " +
      "as input. IMPORTANT: this posts a real, visible message to a real WhatsApp number — confirm the " +
      "number/content with the user before calling this unless they've explicitly asked for this exact message.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient's WhatsApp phone number, E.164 digits with no '+' (e.g. '15551234567')" },
        text: { type: "string", description: "Message text" },
      },
      required: ["to", "text"],
    },
    describeCall: (input) => `send WhatsApp message to ${input.to}: "${input.text.slice(0, 60)}"`,
    async handler(input) {
      if (!config) {
        return {
          content: "WhatsApp is not configured — set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID as environment variables to enable send_whatsapp_message.",
          isError: true,
        };
      }
      const result = await postWhatsappMessage(config, input, apiBaseUrl);
      if (!result.ok) {
        return { content: result.error, isError: true };
      }
      return { content: `Message sent to ${input.to}${result.messageId ? ` (message id: ${result.messageId})` : ""}.`, isError: false };
    },
  };
}
