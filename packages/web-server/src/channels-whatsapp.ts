import type { Express } from "express";
import { verifyWhatsappSignature } from "@finanfa/core/src/channels/whatsapp-signature.js";
import { parseWhatsappPayload, verifyWhatsappWebhookHandshake } from "@finanfa/core/src/channels/whatsapp-event.js";
import { runHeadlessTurn } from "@finanfa/core/src/channels/headless-turn.js";
import { postWhatsappMessage, whatsappConfigFromEnv } from "@finanfa/core/src/tools/builtin/send-whatsapp-message.js";
import { UpdateDedupTracker } from "@finanfa/core/src/channels/update-dedup.js";
import type { RequestWithRawBody } from "./channels-slack.js";

async function handleWhatsappMessage(cwd: string, sessionId: string, from: string, text: string): Promise<void> {
  const config = whatsappConfigFromEnv();
  // Overridable only for tests against a real local fake WhatsApp Cloud
  // API — real deployments always want the real graph.facebook.com default.
  const apiBaseUrl = process.env.WHATSAPP_API_BASE_URL;
  try {
    const { replyText } = await runHeadlessTurn(cwd, sessionId, text);
    if (!replyText.trim()) return;
    if (!config) {
      console.error(`WhatsApp channel: got a reply but WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID aren't set, so it can't be posted back: ${replyText}`);
      return;
    }
    const result = await postWhatsappMessage(config, { to: from, text: replyText }, apiBaseUrl);
    if (!result.ok) console.error(`WhatsApp channel: failed to post reply to ${from}: ${result.error}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`WhatsApp channel: turn failed for ${from}: ${message}`);
    if (config) {
      await postWhatsappMessage(config, { to: from, text: "Sorry, something went wrong handling that." }, apiBaseUrl).catch(() => {});
    }
  }
}

/**
 * Wires up GET+POST /api/channels/whatsapp/webhook — the WhatsApp Cloud
 * API's single combined endpoint (GET is Meta's one-time verification
 * handshake, POST is the signed event stream). `cwd` is the workspace
 * every inbound WhatsApp message runs against (the server's own default
 * workspace, same as every other channel here). No-ops (via a 404 on
 * both routes) unless WHATSAPP_APP_SECRET/WHATSAPP_VERIFY_TOKEN are
 * configured.
 */
export function registerWhatsappChannelRoutes(app: Express, cwd: string): void {
  const dedup = new UpdateDedupTracker<string>();

  app.get("/api/channels/whatsapp/webhook", (req, res) => {
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!verifyToken) {
      res.status(404).json({ error: "WhatsApp channel not configured — set WHATSAPP_VERIFY_TOKEN." });
      return;
    }
    const challenge = verifyWhatsappWebhookHandshake(
      { mode: req.query["hub.mode"] as string | undefined, verifyToken: req.query["hub.verify_token"] as string | undefined, challenge: req.query["hub.challenge"] as string | undefined },
      verifyToken,
    );
    if (challenge === undefined) {
      res.status(403).json({ error: "Invalid WhatsApp webhook verification request." });
      return;
    }
    res.status(200).send(challenge);
  });

  app.post("/api/channels/whatsapp/webhook", (req: RequestWithRawBody, res) => {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      res.status(404).json({ error: "WhatsApp channel not configured — set WHATSAPP_APP_SECRET." });
      return;
    }
    if (!verifyWhatsappSignature({ appSecret, signatureHeader: req.header("X-Hub-Signature-256"), rawBody: req.rawBody?.toString("utf-8") ?? "" })) {
      res.status(401).json({ error: "Invalid WhatsApp signature." });
      return;
    }

    const parsed = parseWhatsappPayload(req.body);
    // Meta just needs a fast 200 to consider the event delivered — ack
    // immediately regardless of what kind of update this was, then handle
    // a real message asynchronously (a full agent turn can take far
    // longer than Meta's own delivery timeout).
    res.status(200).end();
    if (parsed.kind === "ignored") return;
    if (!dedup.markSeen(parsed.event.messageId)) return; // a redelivery of an event already handled — don't run a second turn or post a duplicate reply

    const sessionId = `whatsapp:${parsed.event.from}`;
    void handleWhatsappMessage(cwd, sessionId, parsed.event.from, parsed.event.text);
  });
}
