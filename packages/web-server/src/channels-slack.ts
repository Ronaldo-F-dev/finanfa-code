import type { Express, Request } from "express";
import { verifySlackSignature } from "@finanfa/core/src/channels/slack-signature.js";
import { parseSlackPayload } from "@finanfa/core/src/channels/slack-event.js";
import { runHeadlessTurn } from "@finanfa/core/src/channels/headless-turn.js";
import { postSlackMessage, slackConfigFromEnv } from "@finanfa/core/src/tools/builtin/send-slack-message.js";

/** Populated by the `verify` callback on the app-wide express.json() in index.ts — the signature covers these exact raw bytes, not a re-serialized req.body. */
export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

async function handleSlackMessage(cwd: string, sessionId: string, channel: string, threadKey: string, text: string): Promise<void> {
  const slackConfig = slackConfigFromEnv();
  // Overridable only for tests against a real local fake Slack API — real
  // deployments always want the real https://slack.com/api default.
  const apiBaseUrl = process.env.SLACK_API_BASE_URL;
  try {
    const { replyText } = await runHeadlessTurn(cwd, sessionId, text);
    if (!replyText.trim()) return;
    if (!slackConfig) {
      console.error(`Slack channel: got a reply but SLACK_BOT_TOKEN isn't set, so it can't be posted back: ${replyText}`);
      return;
    }
    const result = await postSlackMessage(slackConfig, { channel, text: replyText, threadTs: threadKey }, apiBaseUrl);
    if (!result.ok) console.error(`Slack channel: failed to post reply to ${channel}: ${result.error}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Slack channel: turn failed for ${channel}/${threadKey}: ${message}`);
    if (slackConfig) {
      await postSlackMessage(slackConfig, { channel, text: "Sorry, something went wrong handling that.", threadTs: threadKey }, apiBaseUrl).catch(
        () => {},
      );
    }
  }
}

/**
 * Wires up POST /api/channels/slack/events — Slack's Events API webhook.
 * `cwd` is the workspace every inbound Slack message runs against (the
 * server's own default workspace, same as a connection with no `?project=`
 * — Slack-channel-to-project routing isn't supported yet). No-ops (via a
 * 404 on the route itself) unless SLACK_SIGNING_SECRET is configured, so
 * an operator who hasn't set up Slack sees a clear signal rather than a
 * silently-unprotected endpoint.
 */
export function registerSlackChannelRoutes(app: Express, cwd: string): void {
  app.post("/api/channels/slack/events", (req: RequestWithRawBody, res) => {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      res.status(404).json({ error: "Slack channel not configured — set SLACK_SIGNING_SECRET." });
      return;
    }

    const verified = verifySlackSignature({
      signingSecret,
      timestamp: req.header("X-Slack-Request-Timestamp"),
      signature: req.header("X-Slack-Signature"),
      rawBody: req.rawBody?.toString("utf-8") ?? "",
    });
    if (!verified) {
      res.status(401).json({ error: "Invalid Slack signature." });
      return;
    }

    const parsed = parseSlackPayload(req.body);
    if (parsed.kind === "url_verification") {
      res.json({ challenge: parsed.challenge });
      return;
    }
    if (parsed.kind !== "message") {
      res.status(200).end();
      return;
    }

    // Ack immediately — Slack expects a response within 3s, well under how
    // long a real agent turn can take. The reply itself is posted back
    // separately via the Slack Web API once the turn finishes.
    res.status(200).end();

    // A retried delivery (Slack didn't see our ack in time, or thinks it
    // didn't) must not run the same message through the agent again —
    // once ack'd, never reprocessed.
    if (req.header("X-Slack-Retry-Num")) return;

    const { channel, threadKey, text } = parsed.event;
    void handleSlackMessage(cwd, `slack:${channel}:${threadKey}`, channel, threadKey, text);
  });
}
