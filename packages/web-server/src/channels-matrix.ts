import type { Express } from "express";
import { verifyMatrixHsToken } from "@finanfa/core/src/channels/matrix-secret.js";
import { parseMatrixTransaction } from "@finanfa/core/src/channels/matrix-event.js";
import { runHeadlessTurn } from "@finanfa/core/src/channels/headless-turn.js";
import { postMatrixMessage, matrixConfigFromEnv } from "@finanfa/core/src/tools/builtin/send-matrix-message.js";
import { UpdateDedupTracker } from "@finanfa/core/src/channels/update-dedup.js";

async function handleMatrixMessage(cwd: string, sessionId: string, roomId: string, text: string): Promise<void> {
  const config = matrixConfigFromEnv();
  try {
    const { replyText } = await runHeadlessTurn(cwd, sessionId, text);
    if (!replyText.trim()) return;
    if (!config) {
      console.error(`Matrix channel: got a reply but MATRIX_HOMESERVER_URL/MATRIX_AS_TOKEN aren't set, so it can't be posted back: ${replyText}`);
      return;
    }
    const result = await postMatrixMessage(config, { roomId, text: replyText });
    if (!result.ok) console.error(`Matrix channel: failed to post reply to room ${roomId}: ${result.error}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Matrix channel: turn failed for room ${roomId}: ${message}`);
    if (config) await postMatrixMessage(config, { roomId, text: "Sorry, something went wrong handling that." }).catch(() => {});
  }
}

/**
 * Wires up PUT /api/channels/matrix/transactions/:txnId — the real
 * Application Service transaction-push endpoint
 * (https://spec.matrix.org/latest/application-service-api/#pushing-events),
 * registered as this AS's own `url` on whichever homeserver it's
 * installed on. `cwd` is the workspace every inbound Matrix message runs
 * against, same as every other channel here. No-ops (via a 404 on the
 * route itself) unless MATRIX_HS_TOKEN/MATRIX_BOT_USER_ID are configured.
 */
export function registerMatrixChannelRoutes(app: Express, cwd: string): void {
  const dedup = new UpdateDedupTracker<string>();

  app.put("/api/channels/matrix/transactions/:txnId", (req, res) => {
    const hsToken = process.env.MATRIX_HS_TOKEN;
    const botUserId = process.env.MATRIX_BOT_USER_ID;
    if (!hsToken || !botUserId) {
      res.status(404).json({ error: "Matrix channel not configured — set MATRIX_HS_TOKEN and MATRIX_BOT_USER_ID." });
      return;
    }
    if (!verifyMatrixHsToken(hsToken, req.header("authorization"))) {
      res.status(401).json({ error: "Invalid Matrix hs_token." });
      return;
    }

    // The homeserver just needs a fast, empty 200 to consider the
    // transaction delivered (spec: "the application service should
    // return an empty JSON body") — ack immediately, then handle any
    // real messages asynchronously.
    res.status(200).json({});

    if (!dedup.markSeen(req.params.txnId)) return; // a redelivery of a transaction already handled

    const messages = parseMatrixTransaction(req.body, botUserId);
    for (const message of messages) {
      const sessionId = `matrix:${message.roomId}`;
      void handleMatrixMessage(cwd, sessionId, message.roomId, message.text);
    }
  });
}
