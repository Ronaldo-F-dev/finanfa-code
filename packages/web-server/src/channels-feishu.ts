import type { Express } from "express";
import { verifyFeishuToken } from "@finanfa/core/src/channels/feishu-secret.js";
import { extractFeishuToken, parseFeishuPayload } from "@finanfa/core/src/channels/feishu-event.js";
import { runHeadlessTurn } from "@finanfa/core/src/channels/headless-turn.js";
import { postFeishuMessage, feishuConfigFromEnv } from "@finanfa/core/src/tools/builtin/send-feishu-message.js";
import { UpdateDedupTracker } from "@finanfa/core/src/channels/update-dedup.js";

async function handleFeishuMessage(cwd: string, sessionId: string, chatId: string, text: string): Promise<void> {
  const config = feishuConfigFromEnv();
  const apiBaseUrl = process.env.FEISHU_API_BASE_URL;
  try {
    const { replyText } = await runHeadlessTurn(cwd, sessionId, text);
    if (!replyText.trim()) return;
    if (!config) {
      console.error(`Feishu channel: got a reply but FEISHU_APP_ID/FEISHU_APP_SECRET aren't set, so it can't be posted back: ${replyText}`);
      return;
    }
    const result = await postFeishuMessage(config, { chatId, text: replyText }, apiBaseUrl);
    if (!result.ok) console.error(`Feishu channel: failed to post reply to chat ${chatId}: ${result.error}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Feishu channel: turn failed for chat ${chatId}: ${message}`);
    if (config) await postFeishuMessage(config, { chatId, text: "Sorry, something went wrong handling that." }, apiBaseUrl).catch(() => {});
  }
}

/**
 * Wires up POST /api/channels/feishu/webhook — Feishu/Lark's event
 * subscription webhook, including the one-time url_verification
 * handshake Feishu requires before it'll save the URL. `cwd` is the
 * workspace every inbound message runs against, same as every other
 * channel here. No-ops (via a 404 on the route itself) unless
 * FEISHU_VERIFICATION_TOKEN is configured.
 */
export function registerFeishuChannelRoutes(app: Express, cwd: string): void {
  const dedup = new UpdateDedupTracker<string>();

  app.post("/api/channels/feishu/webhook", (req, res) => {
    const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN;
    if (!verificationToken) {
      res.status(404).json({ error: "Feishu channel not configured — set FEISHU_VERIFICATION_TOKEN." });
      return;
    }
    if (!verifyFeishuToken(verificationToken, extractFeishuToken(req.body))) {
      res.status(401).json({ error: "Invalid Feishu verification token." });
      return;
    }

    const parsed = parseFeishuPayload(req.body);
    if (parsed.kind === "url_verification") {
      // The one-time setup handshake — Feishu won't save the webhook URL
      // until this echoes its own challenge back.
      res.status(200).json({ challenge: parsed.challenge });
      return;
    }

    // Feishu just needs a fast 200 to consider the event delivered — ack
    // immediately, then handle a real message asynchronously (a full
    // agent turn can take far longer than Feishu's own delivery timeout).
    res.status(200).json({});
    if (parsed.kind === "ignored") return;
    if (!dedup.markSeen(parsed.event.eventId)) return; // a redelivery of an event already handled

    const sessionId = `feishu:${parsed.event.chatId}`;
    void handleFeishuMessage(cwd, sessionId, parsed.event.chatId, parsed.event.text);
  });
}
