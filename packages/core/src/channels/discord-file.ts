// Downloads a Discord CDN attachment's real bytes (an /ask image option —
// see channels-discord.ts). Unlike Slack/Telegram, Discord's attachment
// URLs are public — no bot token needed, just a plain fetch.
export type FetchDiscordFileResult = { ok: true; base64: string } | { ok: false; error: string };

export async function fetchDiscordFile(url: string): Promise<FetchDiscordFileResult> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    return { ok: false, error: `Failed to reach Discord's CDN: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!response.ok) {
    return { ok: false, error: `Discord CDN download returned HTTP ${response.status}.` };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return { ok: true, base64: bytes.toString("base64") };
}
