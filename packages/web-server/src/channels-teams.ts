import type { Express } from "express";
import { verifyTeamsToken } from "@finanfa/core/src/channels/teams-jwt.js";
import { parseTeamsActivity } from "@finanfa/core/src/channels/teams-event.js";
import { runHeadlessTurn } from "@finanfa/core/src/channels/headless-turn.js";
import { postTeamsMessage, teamsConfigFromEnv } from "@finanfa/core/src/tools/builtin/send-teams-message.js";
import { UpdateDedupTracker } from "@finanfa/core/src/channels/update-dedup.js";

async function handleTeamsMessage(cwd: string, sessionId: string, serviceUrl: string, conversationId: string, activityId: string, text: string): Promise<void> {
  const config = teamsConfigFromEnv();
  const tokenUrl = process.env.MICROSOFT_TOKEN_URL;
  try {
    const { replyText } = await runHeadlessTurn(cwd, sessionId, text);
    if (!replyText.trim()) return;
    if (!config) {
      console.error(`Teams channel: got a reply but MICROSOFT_APP_ID/MICROSOFT_APP_PASSWORD aren't set, so it can't be posted back: ${replyText}`);
      return;
    }
    const result = await postTeamsMessage(config, { serviceUrl, conversationId, text: replyText, replyToActivityId: activityId }, tokenUrl);
    if (!result.ok) console.error(`Teams channel: failed to post reply to conversation ${conversationId}: ${result.error}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Teams channel: turn failed for conversation ${conversationId}: ${message}`);
    if (config) {
      await postTeamsMessage(config, { serviceUrl, conversationId, text: "Sorry, something went wrong handling that.", replyToActivityId: activityId }, tokenUrl).catch(() => {});
    }
  }
}

/**
 * Wires up POST /api/channels/teams/webhook — the Bot Framework Connector
 * API's own webhook shape Teams (via Azure Bot Service) posts real
 * Activity objects to. `cwd` is the workspace every inbound message runs
 * against, same as every other channel here. No-ops (via a 404 on the
 * route itself) unless MICROSOFT_APP_ID/MICROSOFT_APP_PASSWORD are
 * configured.
 */
export function registerTeamsChannelRoutes(app: Express, cwd: string): void {
  const dedup = new UpdateDedupTracker<string>();

  app.post("/api/channels/teams/webhook", (req, res) => {
    const appId = process.env.MICROSOFT_APP_ID;
    if (!appId || !process.env.MICROSOFT_APP_PASSWORD) {
      res.status(404).json({ error: "Teams channel not configured — set MICROSOFT_APP_ID and MICROSOFT_APP_PASSWORD." });
      return;
    }

    const authHeader = req.header("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    if (!token) {
      res.status(401).json({ error: "Missing Bot Framework authorization token." });
      return;
    }

    verifyTeamsToken(token, appId, process.env.MICROSOFT_OPENID_CONFIG_URL)
      .then((verified) => {
        if (!verified.ok) {
          res.status(401).json({ error: verified.error });
          return;
        }

        // Bot Framework just needs a fast 200 to consider the activity
        // delivered — ack immediately, then handle a real message
        // asynchronously (a full agent turn can take far longer than its
        // own delivery timeout).
        res.status(200).json({});

        const parsed = parseTeamsActivity(req.body);
        if (parsed.kind === "ignored") return;
        if (!dedup.markSeen(parsed.event.activityId)) return; // a redelivery of an activity already handled

        const sessionId = `teams:${parsed.event.conversationId}`;
        void handleTeamsMessage(cwd, sessionId, parsed.event.serviceUrl, parsed.event.conversationId, parsed.event.activityId, parsed.event.text);
      })
      .catch((err: unknown) => {
        res.status(502).json({ error: `Failed to verify Bot Framework token: ${err instanceof Error ? err.message : String(err)}` });
      });
  });
}
