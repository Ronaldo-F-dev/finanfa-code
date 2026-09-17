import type { ToolDefinition } from "../../core/types.js";
import { getTeamsAccessToken, type TeamsAppConfig } from "../../core/teams-token.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool, same shape as send-feishu-message.ts — posts via
// the Bot Framework Connector API's real conversations/activities
// endpoint (https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-api-reference),
// authenticated with a real OAuth2 token (see teams-token.ts). Unlike
// Telegram/LINE/Feishu's "send to a chat id" model, Teams has no fixed
// API host — `serviceUrl` (which host to actually call) and
// `conversationId` both come from whichever inbound activity this is
// replying to, so both are required inputs here rather than a single
// chat/room id.
export type TeamsConfig = TeamsAppConfig;

export function teamsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TeamsConfig | undefined {
  const appId = env.MICROSOFT_APP_ID;
  const appPassword = env.MICROSOFT_APP_PASSWORD;
  return appId && appPassword ? { appId, appPassword } : undefined;
}

interface SendTeamsMessageInput {
  serviceUrl: string;
  conversationId: string;
  text: string;
  replyToActivityId?: string;
}

interface TeamsSendResponse {
  id?: string;
  error?: { code?: string; message?: string };
}

export type PostTeamsMessageResult = { ok: true; activityId?: string } | { ok: false; error: string };

/**
 * The raw send-activity call, shared by this tool and the inbound Teams
 * channel webhook (see @finanfa/web-server's channels-teams.ts) so
 * neither duplicates the URL shape/error handling. Fetches a real OAuth2
 * access token first (see teams-token.ts) — every send is authenticated
 * with that, not a static credential.
 */
export async function postTeamsMessage(
  config: TeamsConfig,
  input: { serviceUrl: string; conversationId: string; text: string; replyToActivityId?: string },
  tokenUrl?: string,
): Promise<PostTeamsMessageResult> {
  const tokenResult = await getTeamsAccessToken(config, tokenUrl);
  if (!tokenResult.ok) return tokenResult;

  const base = input.serviceUrl.replace(/\/+$/, "");
  const url = input.replyToActivityId
    ? `${base}/v3/conversations/${encodeURIComponent(input.conversationId)}/activities/${encodeURIComponent(input.replyToActivityId)}`
    : `${base}/v3/conversations/${encodeURIComponent(input.conversationId)}/activities`;

  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(url, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenResult.token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", text: input.text }),
    }));
  } catch (err) {
    return { ok: false, error: `Failed to reach the Bot Framework connector: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: TeamsSendResponse;
  try {
    data = JSON.parse(bodyText) as TeamsSendResponse;
  } catch {
    return { ok: false, error: `Bot Framework connector returned an unparseable response (HTTP ${response.status}).` };
  }

  if (!response.ok) return { ok: false, error: data.error?.message ?? `Bot Framework connector error (HTTP ${response.status})` };
  return { ok: true, activityId: data.id };
}

export function createSendTeamsMessageTool(config: TeamsConfig | undefined, tokenUrl?: string): ToolDefinition<SendTeamsMessageInput> {
  return {
    name: "send_teams_message",
    description:
      "Send a real message to a Microsoft Teams conversation via the Bot Framework Connector API. Requires " +
      "MICROSOFT_APP_ID and MICROSOFT_APP_PASSWORD as environment variables — this tool never takes credentials " +
      "as input. serviceUrl/conversationId identify WHERE to send (both come from an inbound Teams activity — " +
      "there's no fixed API host or chat id the way Telegram/LINE have). IMPORTANT: this posts a real, visible " +
      "message — confirm the conversation/content with the user before calling this unless they've explicitly " +
      "asked for this exact message.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        serviceUrl: { type: "string", description: "The Bot Framework serviceUrl this conversation is on (from an inbound activity)" },
        conversationId: { type: "string", description: "The conversation id to send to (from an inbound activity)" },
        text: { type: "string", description: "Message text" },
        replyToActivityId: { type: "string", description: "Optional — reply to this specific activity id instead of posting a new one" },
      },
      required: ["serviceUrl", "conversationId", "text"],
    },
    describeCall: (input) => `send Teams message to conversation ${input.conversationId}: "${input.text.slice(0, 60)}"`,
    async handler(input) {
      if (!config) {
        return { content: "Teams is not configured — set MICROSOFT_APP_ID and MICROSOFT_APP_PASSWORD as environment variables to enable send_teams_message.", isError: true };
      }
      const result = await postTeamsMessage(config, input, tokenUrl);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `Message sent to conversation ${input.conversationId}${result.activityId ? ` (activity id: ${result.activityId})` : ""}.`, isError: false };
    },
  };
}
