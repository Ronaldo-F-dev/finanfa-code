import type { ToolDefinition } from "../../core/types.js";

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
      let response: Response;
      try {
        response = await fetch(`${apiBaseUrl}/chat.postMessage`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.botToken}`, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ channel: input.channel, text: input.text }),
        });
      } catch (err) {
        return { content: `Failed to reach Slack: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }

      let data: SlackApiResponse;
      try {
        data = (await response.json()) as SlackApiResponse;
      } catch {
        return { content: `Slack returned an unparseable response (HTTP ${response.status}).`, isError: true };
      }

      if (!data.ok) {
        return { content: `Slack rejected the message: ${data.error ?? "unknown error"}.`, isError: true };
      }
      return { content: `Message posted to ${input.channel}${data.ts ? ` (ts: ${data.ts})` : ""}.`, isError: false };
    },
  };
}
