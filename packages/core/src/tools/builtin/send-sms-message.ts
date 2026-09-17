import type { ToolDefinition } from "../../core/types.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool, same shape as send-whatsapp-message.ts/
// send-telegram-message.ts — sends via Twilio's real Programmable
// Messaging REST API. Twilio authenticates with HTTP Basic Auth
// (AccountSid:AuthToken), unlike every other channel here's Bearer/token
// scheme.
export interface SmsConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export function smsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmsConfig | undefined {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const fromNumber = env.TWILIO_FROM_NUMBER;
  return accountSid && authToken && fromNumber ? { accountSid, authToken, fromNumber } : undefined;
}

interface SendSmsMessageInput {
  to: string;
  text: string;
}

interface TwilioApiErrorResponse {
  message?: string;
  code?: number;
}

interface TwilioApiSuccessResponse {
  sid?: string;
}

export type PostSmsMessageResult = { ok: true; messageSid?: string } | { ok: false; error: string };

/**
 * The raw "send message" call, shared by this tool and (were an inbound
 * channel ever to reply proactively outside a webhook handler) anything
 * else that wants to text a number.
 */
export async function postSmsMessage(config: SmsConfig, input: { to: string; text: string }, apiBaseUrl = "https://api.twilio.com/2010-04-01"): Promise<PostSmsMessageResult> {
  const basicAuth = Buffer.from(`${config.accountSid}:${config.authToken}`, "utf-8").toString("base64");
  const body = new URLSearchParams({ To: input.to, From: config.fromNumber, Body: input.text });

  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(
      `${apiBaseUrl}/Accounts/${config.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${basicAuth}`, "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      { retryAfterMs: parseRetryAfterHeaderMs },
    ));
  } catch (err) {
    return { ok: false, error: `Failed to reach Twilio: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    let data: TwilioApiErrorResponse = {};
    try {
      data = JSON.parse(bodyText) as TwilioApiErrorResponse;
    } catch {
      // Non-JSON error body — fall through with the plain status text below.
    }
    return { ok: false, error: data.message ?? `Twilio returned HTTP ${response.status}.` };
  }

  const data = JSON.parse(bodyText) as TwilioApiSuccessResponse;
  return { ok: true, messageSid: data.sid };
}

function parseRetryAfterHeaderMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export function createSendSmsMessageTool(config: SmsConfig | undefined, apiBaseUrl = "https://api.twilio.com/2010-04-01"): ToolDefinition<SendSmsMessageInput> {
  return {
    name: "send_sms_message",
    description:
      "Send a real SMS via Twilio's Programmable Messaging API. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, " +
      "and TWILIO_FROM_NUMBER to be configured as environment variables — this tool never takes credentials as " +
      "input. IMPORTANT: this sends a real, billed text message to a real phone number — confirm the " +
      "number/content with the user before calling this unless they've explicitly asked for this exact message.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient phone number, E.164 format (e.g. '+15551234567')" },
        text: { type: "string", description: "Message text" },
      },
      required: ["to", "text"],
    },
    describeCall: (input) => `send SMS to ${input.to}: "${input.text.slice(0, 60)}"`,
    async handler(input) {
      if (!config) {
        return {
          content: "SMS is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER as environment variables to enable send_sms_message.",
          isError: true,
        };
      }
      const result = await postSmsMessage(config, input, apiBaseUrl);
      if (!result.ok) {
        return { content: result.error, isError: true };
      }
      return { content: `Message sent to ${input.to}${result.messageSid ? ` (sid: ${result.messageSid})` : ""}.`, isError: false };
    },
  };
}
