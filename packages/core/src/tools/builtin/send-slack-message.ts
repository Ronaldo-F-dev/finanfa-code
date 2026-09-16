import type { ToolDefinition } from "../../core/types.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool, inspired by n8n/OpenHands' third-party
// integrations — posts to Slack via the real Web API (chat.postMessage),
// using a bot token so it can post to any channel by name/ID rather than
// being locked to one fixed incoming-webhook URL. No SDK dependency
// needed: it's a single authenticated JSON POST, exactly like this
// project's own http_request tool but with Slack's auth/error-shape
// handled for you.
//
// Credentials come from env vars (SLACK_BOT_TOKEN), never from tool
// input.
export interface SlackConfig {
  botToken: string;
}

export function slackConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SlackConfig | undefined {
  const botToken = env.SLACK_BOT_TOKEN;
  return botToken ? { botToken } : undefined;
}

interface SendSlackMessageInput {
  channel: string;
  text: string;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
}

export type PostSlackMessageResult = { ok: true; ts?: string } | { ok: false; error: string };

/**
 * The raw chat.postMessage call, shared by this tool and the inbound
 * Slack channel webhook (see @finanfa/web-server's channels/slack.ts) so
 * neither duplicates Slack's auth header/error-shape handling.
 */
export async function postSlackMessage(
  config: SlackConfig,
  input: { channel: string; text: string; threadTs?: string },
  apiBaseUrl = "https://slack.com/api",
): Promise<PostSlackMessageResult> {
  let response: Response;
  let bodyText: string;
  try {
    // Slack reports a real HTTP 429 (not just ok:false) with a plain
    // integer Retry-After header (seconds) when actually rate-limited —
    // honored here instead of guessing at a generic backoff delay.
    ({ response, bodyText } = await fetchWithRetry(
      `${apiBaseUrl}/chat.postMessage`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${config.botToken}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: input.channel, text: input.text, thread_ts: input.threadTs }),
      },
      { retryAfterMs: (response) => parseRetryAfterHeaderMs(response) },
    ));
  } catch (err) {
    return { ok: false, error: `Failed to reach Slack: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: SlackApiResponse;
  try {
    data = JSON.parse(bodyText) as SlackApiResponse;
  } catch {
    return { ok: false, error: `Slack returned an unparseable response (HTTP ${response.status}).` };
  }

  return data.ok ? { ok: true, ts: data.ts } : { ok: false, error: data.error ?? "unknown error" };
}

function parseRetryAfterHeaderMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export function createSendSlackMessageTool(config: SlackConfig | undefined, apiBaseUrl = "https://slack.com/api"): ToolDefinition<SendSlackMessageInput> {
  return {
    name: "send_slack_message",
    description:
      "Post a real message to a Slack channel via the Slack Web API (chat.postMessage). Requires " +
      "SLACK_BOT_TOKEN to be configured as an environment variable (a bot token with the chat:write scope, " +
      "invited to the target channel) — this tool never takes credentials as input. " +
      "IMPORTANT: this posts a real, visible message to a real channel — confirm the channel/content with the " +
      "user before calling this unless they've explicitly asked for this exact message.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name (e.g. #general) or channel ID" },
        text: { type: "string", description: "Message text" },
      },
      required: ["channel", "text"],
    },
    describeCall: (input) => `post Slack message to ${input.channel}: "${input.text.slice(0, 60)}"`,
    async handler(input) {
      if (!config) {
        return { content: "Slack is not configured — set SLACK_BOT_TOKEN as an environment variable to enable send_slack_message.", isError: true };
      }
      const result = await postSlackMessage(config, input, apiBaseUrl);
      if (!result.ok) {
        return { content: result.error, isError: true };
      }
      return { content: `Message posted to ${input.channel}${result.ts ? ` (ts: ${result.ts})` : ""}.`, isError: false };
    },
  };
}
