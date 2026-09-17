import type { Express } from "express";
import express from "express";
import { verifyTwilioSignature } from "@finanfa/core/src/channels/twilio-signature.js";
import { parseTwilioSmsPayload } from "@finanfa/core/src/channels/sms-event.js";
import { runHeadlessTurn } from "@finanfa/core/src/channels/headless-turn.js";
import { postSmsMessage, smsConfigFromEnv } from "@finanfa/core/src/tools/builtin/send-sms-message.js";
import { UpdateDedupTracker } from "@finanfa/core/src/channels/update-dedup.js";

async function handleSmsMessage(cwd: string, sessionId: string, from: string, text: string): Promise<void> {
  const config = smsConfigFromEnv();
  // Overridable only for tests against a real local fake Twilio API —
  // real deployments always want the real https://api.twilio.com default.
  const apiBaseUrl = process.env.TWILIO_API_BASE_URL;
  try {
    const { replyText } = await runHeadlessTurn(cwd, sessionId, text);
    if (!replyText.trim()) return;
    if (!config) {
      console.error(`SMS channel: got a reply but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER aren't set, so it can't be posted back: ${replyText}`);
      return;
    }
    const result = await postSmsMessage(config, { to: from, text: replyText }, apiBaseUrl);
    if (!result.ok) console.error(`SMS channel: failed to reply to ${from}: ${result.error}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`SMS channel: turn failed for ${from}: ${message}`);
    if (config) {
      await postSmsMessage(config, { to: from, text: "Sorry, something went wrong handling that." }, apiBaseUrl).catch(() => {});
    }
  }
}

/**
 * Wires up POST /api/channels/sms/webhook — Twilio's Programmable
 * Messaging inbound webhook. `cwd` is the workspace every inbound SMS
 * runs against (the server's own default workspace, same as every other
 * channel here). No-ops (via a 404 on the route) unless
 * TWILIO_AUTH_TOKEN/TWILIO_WEBHOOK_URL are configured. Uses its own
 * express.urlencoded() middleware scoped to just this route — Twilio's
 * webhook body is form-urlencoded, not JSON like every other channel's,
 * so it can't share the app-wide express.json() middleware.
 */
export function registerSmsChannelRoutes(app: Express, cwd: string): void {
  const dedup = new UpdateDedupTracker<string>();

  app.post("/api/channels/sms/webhook", express.urlencoded({ extended: false }), (req, res) => {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    // Twilio signs the exact webhook URL configured in its console —
    // reconstructing it from the request itself (rather than trusting a
    // client-supplied header) means this only works correctly when the
    // server is reachable at that same public URL, same assumption every
    // other channel's own webhook makes.
    const webhookUrl = process.env.TWILIO_WEBHOOK_URL ?? `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    if (!authToken) {
      res.status(404).json({ error: "SMS channel not configured — set TWILIO_AUTH_TOKEN." });
      return;
    }
    if (!verifyTwilioSignature({ authToken, url: webhookUrl, params: req.body as Record<string, string>, signatureHeader: req.header("X-Twilio-Signature") })) {
      res.status(401).json({ error: "Invalid Twilio signature." });
      return;
    }

    const parsed = parseTwilioSmsPayload(req.body as Record<string, string>);
    // Twilio just needs a fast 200 to consider the message delivered —
    // ack immediately, then handle a real message asynchronously (a full
    // agent turn can take far longer than Twilio's own delivery timeout).
    // Twilio expects an empty (or TwiML) response body on success.
    res.status(200).type("text/xml").send("<Response></Response>");
    if (parsed.kind === "ignored") return;
    if (!dedup.markSeen(parsed.event.messageSid)) return; // a redelivery of a message already handled — don't run a second turn or post a duplicate reply

    const sessionId = `sms:${parsed.event.from}`;
    void handleSmsMessage(cwd, sessionId, parsed.event.from, parsed.event.text);
  });
}
