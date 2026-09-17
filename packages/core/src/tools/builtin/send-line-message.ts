import type { ToolDefinition } from "../../core/types.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool, same shape as send-telegram-message.ts — posts
// via LINE's real Messaging API push endpoint
// (https://developers.line.biz/en/reference/messaging-api/#send-push-message),
// not the reply endpoint: a reply token is one-time-use and expires
// quickly, which doesn't fit a real agent turn that can take far longer
// to produce an answer (same "ack fast, reply later via a real send API"
// shape as every text-based channel in this project).
export interface LineConfig {
  channelAccessToken: string;
}

export function lineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LineConfig | undefined {
  const channelAccessToken = env.LINE_CHANNEL_ACCESS_TOKEN;
  return channelAccessToken ? { channelAccessToken } : undefined;
}

interface SendLineMessageInput {
  to: string;
  text: string;
}

interface LineErrorResponse {
  message?: string;
}

export type PostLineMessageResult = { ok: true } | { ok: false; error: string };

/**
 * The raw push call, shared by this tool and the inbound LINE channel
 * webhook (see @finanfa/web-server's channels-line.ts) so neither
 * duplicates LINE's URL shape/error handling.
 */
export async function postLineMessage(config: LineConfig, input: { to: string; text: string }, apiBaseUrl = "https://api.line.me"): Promise<PostLineMessageResult> {
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(`${apiBaseUrl}/v2/bot/message/push`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.channelAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ to: input.to, messages: [{ type: "text", text: input.text }] }),
    }));
  } catch (err) {
    return { ok: false, error: `Failed to reach LINE: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (response.ok) return { ok: true };
  let data: LineErrorResponse | undefined;
  try {
    data = JSON.parse(bodyText) as LineErrorResponse;
  } catch {
    return { ok: false, error: `LINE returned an unparseable response (HTTP ${response.status}).` };
  }
  return { ok: false, error: data?.message ?? `LINE API error (HTTP ${response.status})` };
}

export function createSendLineMessageTool(config: LineConfig | undefined, apiBaseUrl = "https://api.line.me"): ToolDefinition<SendLineMessageInput> {
  return {
    name: "send_line_message",
    description:
      "Send a real message to a LINE user/group/room via the Messaging API's push endpoint. Requires " +
      "LINE_CHANNEL_ACCESS_TOKEN as an environment variable — this tool never takes credentials as input. " +
      "IMPORTANT: this posts a real, visible message — confirm the recipient/content with the user before " +
      "calling this unless they've explicitly asked for this exact message.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "LINE user/group/room id to send to" },
        text: { type: "string", description: "Message text" },
      },
      required: ["to", "text"],
    },
    describeCall: (input) => `send LINE message to ${input.to}: "${input.text.slice(0, 60)}"`,
    async handler(input) {
      if (!config) {
        return { content: "LINE is not configured — set LINE_CHANNEL_ACCESS_TOKEN as an environment variable to enable send_line_message.", isError: true };
      }
      const result = await postLineMessage(config, input, apiBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `Message sent to ${input.to}.`, isError: false };
    },
  };
}
