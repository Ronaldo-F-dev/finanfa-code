import type { Express } from "express";
import { verifyLineSignature } from "@finanfa/core/src/channels/line-signature.js";
import { parseLineWebhookBody } from "@finanfa/core/src/channels/line-event.js";
import { runHeadlessTurn } from "@finanfa/core/src/channels/headless-turn.js";
import { postLineMessage, lineConfigFromEnv } from "@finanfa/core/src/tools/builtin/send-line-message.js";
import { UpdateDedupTracker } from "@finanfa/core/src/channels/update-dedup.js";

async function handleLineMessage(cwd: string, sessionId: string, targetId: string, text: string): Promise<void> {
  const config = lineConfigFromEnv();
  // Overridable only for tests against a real local fake LINE API — real
  // deployments always want the real https://api.line.me default (see
  // send-line-message.ts's own default parameter).
  const apiBaseUrl = process.env.LINE_API_BASE_URL;
  try {
    const { replyText } = await runHeadlessTurn(cwd, sessionId, text);
    if (!replyText.trim()) return;
    if (!config) {
      console.error(`LINE channel: got a reply but LINE_CHANNEL_ACCESS_TOKEN isn't set, so it can't be posted back: ${replyText}`);
      return;
    }
    const result = await postLineMessage(config, { to: targetId, text: replyText }, apiBaseUrl);
    if (!result.ok) console.error(`LINE channel: failed to post reply to ${targetId}: ${result.error}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`LINE channel: turn failed for ${targetId}: ${message}`);
    if (config) await postLineMessage(config, { to: targetId, text: "Sorry, something went wrong handling that." }, apiBaseUrl).catch(() => {});
  }
}

/**
 * Wires up POST /api/channels/line/webhook — LINE's Messaging API
 * webhook. `cwd` is the workspace every inbound LINE message runs
 * against, same as every other channel here. No-ops (via a 404 on the
 * route itself) unless LINE_CHANNEL_SECRET is configured.
 */
export function registerLineChannelRoutes(app: Express, cwd: string): void {
  const dedup = new UpdateDedupTracker<string>();

  app.post("/api/channels/line/webhook", (req, res) => {
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    if (!channelSecret) {
      res.status(404).json({ error: "LINE channel not configured — set LINE_CHANNEL_SECRET." });
      return;
    }
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody?.toString("utf-8") ?? JSON.stringify(req.body);
    if (!verifyLineSignature(channelSecret, req.header("x-line-signature"), rawBody)) {
      res.status(401).json({ error: "Invalid LINE signature." });
      return;
    }

    // LINE just needs a fast 200 to consider the webhook delivered — ack
    // immediately, then handle any real messages asynchronously (a full
    // agent turn routinely takes longer than LINE's own webhook timeout).
    res.status(200).end();

    const messages = parseLineWebhookBody(req.body);
    for (const message of messages) {
      if (!dedup.markSeen(message.webhookEventId)) continue; // a redelivery of an event already handled
      const sessionId = `line:${message.targetId}`;
      void handleLineMessage(cwd, sessionId, message.targetId, message.text);
    }
  });
}
