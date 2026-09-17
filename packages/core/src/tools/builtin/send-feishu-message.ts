import type { ToolDefinition } from "../../core/types.js";
import { getFeishuTenantAccessToken, type FeishuAppConfig } from "../../core/feishu-token.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool, same shape as send-line-message.ts — posts via
// Feishu/Lark's real IM API (https://open.feishu.cn/document/server-docs/im-v1/message/create),
// authenticated with a real tenant_access_token (see feishu-token.ts) —
// fetched fresh (or from cache) on every call rather than a static bot
// token, since that's genuinely how Feishu's own auth model works.
export type FeishuConfig = FeishuAppConfig;

export function feishuConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FeishuConfig | undefined {
  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;
  return appId && appSecret ? { appId, appSecret } : undefined;
}

interface SendFeishuMessageInput {
  chatId: string;
  text: string;
}

interface FeishuSendResponse {
  code: number;
  msg?: string;
}

export type PostFeishuMessageResult = { ok: true } | { ok: false; error: string };

/**
 * The raw send-message call, shared by this tool and the inbound Feishu
 * channel webhook (see @finanfa/web-server's channels-feishu.ts) so
 * neither duplicates the URL shape/error handling. Fetches a real
 * tenant_access_token first (see feishu-token.ts) — every send is
 * authenticated with that, not a static credential.
 */
export async function postFeishuMessage(config: FeishuConfig, input: { chatId: string; text: string }, apiBaseUrl = "https://open.feishu.cn"): Promise<PostFeishuMessageResult> {
  const tokenResult = await getFeishuTenantAccessToken(config, apiBaseUrl);
  if (!tokenResult.ok) return tokenResult;

  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(`${apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenResult.token}`, "content-type": "application/json" },
      body: JSON.stringify({ receive_id: input.chatId, msg_type: "text", content: JSON.stringify({ text: input.text }) }),
    }));
  } catch (err) {
    return { ok: false, error: `Failed to reach Feishu: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: FeishuSendResponse;
  try {
    data = JSON.parse(bodyText) as FeishuSendResponse;
  } catch {
    return { ok: false, error: `Feishu returned an unparseable response (HTTP ${response.status}).` };
  }

  if (!response.ok || data.code !== 0) return { ok: false, error: data.msg ?? `Feishu API error (HTTP ${response.status}, code ${data.code})` };
  return { ok: true };
}

export function createSendFeishuMessageTool(config: FeishuConfig | undefined, apiBaseUrl = "https://open.feishu.cn"): ToolDefinition<SendFeishuMessageInput> {
  return {
    name: "send_feishu_message",
    description:
      "Send a real message to a Feishu/Lark chat via the IM API. Requires FEISHU_APP_ID and FEISHU_APP_SECRET " +
      "as environment variables — this tool never takes credentials as input. IMPORTANT: this posts a real, " +
      "visible message to a real chat — confirm the chat/content with the user before calling this unless " +
      "they've explicitly asked for this exact message.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "Feishu chat id (as seen in an inbound event's chat_id)" },
        text: { type: "string", description: "Message text" },
      },
      required: ["chatId", "text"],
    },
    describeCall: (input) => `send Feishu message to ${input.chatId}: "${input.text.slice(0, 60)}"`,
    async handler(input) {
      if (!config) {
        return { content: "Feishu is not configured — set FEISHU_APP_ID and FEISHU_APP_SECRET as environment variables to enable send_feishu_message.", isError: true };
      }
      const result = await postFeishuMessage(config, input, apiBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `Message sent to ${input.chatId}.`, isError: false };
    },
  };
}
