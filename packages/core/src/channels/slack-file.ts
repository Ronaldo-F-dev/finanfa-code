import type { SlackConfig } from "../tools/builtin/send-slack-message.js";

// Downloads a Slack-hosted file's real bytes (an image attachment on an
// inbound message — see channels-slack.ts). Unlike Telegram's two-step
// getFile + download, Slack's url_private is already the download URL —
// it just isn't public: it 403s without the bot's own Bearer token.
export type FetchSlackFileResult = { ok: true; base64: string } | { ok: false; error: string };

export async function fetchSlackFile(config: SlackConfig, url: string): Promise<FetchSlackFileResult> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${config.botToken}` } });
  } catch (err) {
    return { ok: false, error: `Failed to reach Slack: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!response.ok) {
    return { ok: false, error: `Slack file download returned HTTP ${response.status}.` };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return { ok: true, base64: bytes.toString("base64") };
}
