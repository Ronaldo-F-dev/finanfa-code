import type { Express } from "express";
import { verifyDiscordSignature } from "@finanfa/core/src/channels/discord-signature.js";
import { parseDiscordInteraction, type DiscordImageAttachment } from "@finanfa/core/src/channels/discord-event.js";
import { runHeadlessTurn } from "@finanfa/core/src/channels/headless-turn.js";
import { resolvePendingConfirmation } from "@finanfa/core/src/channels/pending-confirmations.js";
import { patchDiscordInteractionResponse, sendDiscordFollowupMessage, type DiscordButton } from "@finanfa/core/src/tools/builtin/send-discord-message.js";
import { fetchDiscordFile } from "@finanfa/core/src/channels/discord-file.js";
import type { NeutralImage } from "@finanfa/core/src/core/types.js";
import type { RequestWithRawBody } from "./channels-slack.js";

// PermissionManager's own promptUser (permissions/manager.ts) always
// includes this exact substring in a permission-confirmation prompt —
// matched here so a Discord confirmation gets real tappable buttons
// instead of asking the user to type y/n/a/t by hand (see
// channels-telegram.ts for the same convention).
const CONFIRMATION_PROMPT_MARKER = "[y]es / [n]o";

const CONFIRMATION_BUTTONS: DiscordButton[] = [
  { label: "✅ Yes", customId: "confirm_y", style: 3 },
  { label: "❌ No", customId: "confirm_n", style: 4 },
  { label: "Always this action", customId: "confirm_a" },
  { label: "Always allow this tool", customId: "confirm_t" },
];

async function handleDiscordCommand(
  cwd: string,
  applicationId: string,
  interactionToken: string,
  channelId: string,
  text: string,
  image?: DiscordImageAttachment,
): Promise<void> {
  // Overridable only for tests against a real local fake Discord API —
  // real deployments always want the real https://discord.com/api/v10 default.
  const apiBaseUrl = process.env.DISCORD_API_BASE_URL;
  // Real remote-confirmation support: a tool needing "ask" permission can
  // post its confirmation question back into this channel as a followup
  // message with real buttons, instead of being auto-denied outright (see
  // pending-confirmations.ts and headless-turn.ts's own askUser).
  const sendMessage = async (replyText: string): Promise<void> => {
    const buttons = replyText.includes(CONFIRMATION_PROMPT_MARKER) ? CONFIRMATION_BUTTONS : undefined;
    const result = await sendDiscordFollowupMessage(applicationId, interactionToken, replyText, buttons, apiBaseUrl);
    if (!result.ok) console.error(`Discord channel: failed to post followup message to channel ${channelId}: ${result.error}`);
  };
  try {
    let images: NeutralImage[] | undefined;
    if (image) {
      const file = await fetchDiscordFile(image.url);
      if (file.ok) images = [{ mimeType: image.mimeType, base64: file.base64 }];
      else console.error(`Discord channel: failed to download an image attachment: ${file.error}`);
    }
    const { replyText } = await runHeadlessTurn(cwd, `discord:${channelId}`, text, images, sendMessage);
    const result = await patchDiscordInteractionResponse(applicationId, interactionToken, replyText || "(no reply)", apiBaseUrl);
    if (!result.ok) console.error(`Discord channel: failed to patch deferred response for channel ${channelId}: ${result.error}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Discord channel: turn failed for channel ${channelId}: ${message}`);
    await patchDiscordInteractionResponse(applicationId, interactionToken, "Sorry, something went wrong handling that.", apiBaseUrl).catch(() => {});
  }
}

/** Maps a confirmation button's own custom_id back to the y/n/a/t vocabulary PermissionManager's text-answer path already expects. */
function answerFromCustomId(customId: string): string | undefined {
  const match = /^confirm_([ynat])$/.exec(customId);
  return match?.[1];
}

/**
 * Wires up POST /api/channels/discord/interactions — Discord's
 * Interactions Endpoint URL. Unlike Slack/Telegram (a persistent chat the
 * bot listens to), Discord's HTTP webhook model only delivers
 * interactions (slash commands, buttons, ...), not plain channel
 * messages, so this registers exactly one slash command, `/ask
 * message:<text>` (registered separately via Discord's REST API — see
 * the README). `cwd` is the workspace every command runs against, same
 * as the Slack/Telegram channels. No-ops (via a 404 on the route itself)
 * unless DISCORD_PUBLIC_KEY is configured.
 */
export function registerDiscordChannelRoutes(app: Express, cwd: string): void {
  app.post("/api/channels/discord/interactions", (req: RequestWithRawBody, res) => {
    const publicKeyHex = process.env.DISCORD_PUBLIC_KEY;
    if (!publicKeyHex) {
      res.status(404).json({ error: "Discord channel not configured — set DISCORD_PUBLIC_KEY." });
      return;
    }

    const verified = verifyDiscordSignature({
      publicKeyHex,
      timestamp: req.header("X-Signature-Timestamp"),
      signature: req.header("X-Signature-Ed25519"),
      rawBody: req.rawBody?.toString("utf-8") ?? "",
    });
    if (!verified) {
      res.status(401).json({ error: "Invalid Discord signature." });
      return;
    }

    const parsed = parseDiscordInteraction(req.body);
    if (parsed.kind === "ping") {
      res.json({ type: 1 });
      return;
    }
    if (parsed.kind === "component") {
      // type 6 = DEFERRED_UPDATE_MESSAGE — acks the tap with no visible
      // change to the message (unlike Telegram's separate
      // answerCallbackQuery call, Discord's ack IS this response).
      res.json({ type: 6 });
      const answer = answerFromCustomId(parsed.event.customId);
      if (answer) resolvePendingConfirmation(`discord:${parsed.event.channelId}`, answer);
      return;
    }
    if (parsed.kind !== "command") {
      res.status(200).end();
      return;
    }

    const applicationId = process.env.DISCORD_APPLICATION_ID;
    if (!applicationId) {
      // type 4 = an immediate, non-deferred reply — used here instead of
      // type 5 since there's no application id to PATCH a deferred one
      // with later.
      res.json({ type: 4, data: { content: "Discord channel misconfigured on the server — DISCORD_APPLICATION_ID isn't set." } });
      return;
    }

    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE — Discord shows
    // "<bot> is thinking..." immediately, since a real agent turn takes
    // far longer than the 3 seconds an immediate (type 4) reply allows.
    res.json({ type: 5 });

    void handleDiscordCommand(cwd, applicationId, parsed.event.interactionToken, parsed.event.channelId, parsed.event.text, parsed.event.image);
  });
}
