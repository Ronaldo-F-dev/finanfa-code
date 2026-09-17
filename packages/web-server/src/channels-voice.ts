import type { Express, Request } from "express";
import express from "express";
import { verifyTwilioSignature } from "@finanfa/core/src/channels/twilio-signature.js";
import { parseVoiceCallStart, parseVoiceSpeech, gatherSpeechTwiml, sayAndHangupTwiml } from "@finanfa/core/src/channels/voice-event.js";
import { runHeadlessTurn } from "@finanfa/core/src/channels/headless-turn.js";
import { postSmsMessage, smsConfigFromEnv } from "@finanfa/core/src/tools/builtin/send-sms-message.js";

// Twilio Programmable Voice waits on the phone call for this exact HTTP
// response before it can say anything — unlike every other inbound
// channel here (Slack/Telegram/Discord/WhatsApp/SMS), which ack
// immediately and post the real reply back later via its own send API.
// A tool-calling turn routinely takes longer than a caller will wait on
// hold (and longer than Twilio's own webhook timeout), so this races the
// real agent turn against a deadline: within it, keep the call going with
// the real reply; past it, tell the caller honestly instead of leaving
// them listening to silence, and (when SMS is also configured for the
// same Twilio number) text the eventual answer once the turn finishes.
const TURN_DEADLINE_MS = 8_000;

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ kind: "resolved"; value: T } | { kind: "timedOut" }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timedOut" }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: "resolved", value });
      },
      () => {
        clearTimeout(timer);
        resolve({ kind: "timedOut" }); // an error is handled the same as a timeout here — either way the call can't get a real reply in time
      },
    );
  });
}

/** Best-effort: texts `text` to `to` if SMS is configured for the same Twilio account, silently does nothing otherwise (there's no other way to reach a caller once the call has ended). */
async function trySmsFollowUp(to: string, text: string): Promise<void> {
  const config = smsConfigFromEnv();
  if (!config) return;
  const apiBaseUrl = process.env.TWILIO_API_BASE_URL;
  await postSmsMessage(config, { to, text }, apiBaseUrl).catch(() => {});
}

/**
 * Wires up the Twilio Programmable Voice inbound webhooks: `POST
 * /api/channels/voice/webhook` (a new call — Twilio calls this the moment
 * someone dials the configured number) and `POST
 * /api/channels/voice/gather` (the caller's spoken reply, from the
 * `<Gather input="speech">` the first response set up). `cwd` is the
 * workspace every call runs against, same as every other channel. No-ops
 * (404) unless TWILIO_AUTH_TOKEN is configured.
 *
 * Each call gets its own session (keyed by Twilio's own CallSid, not the
 * caller's number) — unlike SMS/WhatsApp, where the same sender's thread
 * persists across days, a phone call is a single bounded conversation
 * with a natural start and end.
 */
export function registerVoiceChannelRoutes(app: Express, cwd: string): void {
  const urlencoded = express.urlencoded({ extended: false });

  function hasValidSignature(req: Request): boolean {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return false;
    const webhookUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    return verifyTwilioSignature({ authToken, url: webhookUrl, params: req.body as Record<string, string>, signatureHeader: req.header("X-Twilio-Signature") });
  }

  app.post("/api/channels/voice/webhook", urlencoded, (req, res) => {
    if (!process.env.TWILIO_AUTH_TOKEN) {
      res.status(404).json({ error: "Voice channel not configured — set TWILIO_AUTH_TOKEN." });
      return;
    }
    if (!hasValidSignature(req)) {
      res.status(401).json({ error: "Invalid Twilio signature." });
      return;
    }
    const call = parseVoiceCallStart(req.body as Record<string, string>);
    if (!call) {
      res.status(400).type("text/xml").send(sayAndHangupTwiml("Sorry, something went wrong. Goodbye."));
      return;
    }
    const actionUrl = `${req.protocol}://${req.get("host")}/api/channels/voice/gather`;
    res.status(200).type("text/xml").send(gatherSpeechTwiml(actionUrl, "Hi, how can I help you?", "I didn't hear anything. Goodbye."));
  });

  app.post("/api/channels/voice/gather", urlencoded, (req, res) => {
    if (!process.env.TWILIO_AUTH_TOKEN) {
      res.status(404).json({ error: "Voice channel not configured — set TWILIO_AUTH_TOKEN." });
      return;
    }
    if (!hasValidSignature(req)) {
      res.status(401).json({ error: "Invalid Twilio signature." });
      return;
    }
    const speech = parseVoiceSpeech(req.body as Record<string, string>);
    if (!speech) {
      res.status(400).type("text/xml").send(sayAndHangupTwiml("Sorry, something went wrong. Goodbye."));
      return;
    }
    if (!speech.speechResult) {
      res.status(200).type("text/xml").send(sayAndHangupTwiml("I didn't catch that. Goodbye."));
      return;
    }

    const actionUrl = `${req.protocol}://${req.get("host")}/api/channels/voice/gather`;
    const sessionId = `voice:${speech.callSid}`;
    const turn = runHeadlessTurn(cwd, sessionId, speech.speechResult);

    void raceWithTimeout(turn, TURN_DEADLINE_MS).then((outcome) => {
      if (outcome.kind === "resolved") {
        const replyText = outcome.value.replyText.trim() || "I don't have anything to add to that.";
        res.status(200).type("text/xml").send(gatherSpeechTwiml(actionUrl, replyText, "Goodbye."));
        return;
      }
      // The turn is still running — tell the caller honestly instead of
      // leaving them on hold past Twilio's own webhook timeout, then
      // follow up over SMS (if configured) once it actually finishes.
      const smsConfigured = Boolean(smsConfigFromEnv());
      res.status(200).type("text/xml").send(sayAndHangupTwiml(smsConfigured ? "That's going to take me a moment — I'll text you the answer. Goodbye." : "Sorry, that's taking longer than I can stay on the line for. Goodbye."));
      void turn.then((result) => {
        if (result.replyText.trim()) void trySmsFollowUp(speech.from, result.replyText);
      }, () => {});
    });
  });
}
