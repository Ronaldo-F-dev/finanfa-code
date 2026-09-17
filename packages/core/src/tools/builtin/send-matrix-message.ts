import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../../core/types.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool, same shape as send-telegram-message.ts — posts
// to a Matrix room via the real Client-Server API
// (https://spec.matrix.org/latest/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid),
// authenticated as the Application Service itself (asToken), against
// whichever homeserver the AS is registered on — self-hosted (Synapse,
// Dendrite, Conduit) or a hosted one, Matrix being federated means this
// works the same way regardless.
export interface MatrixConfig {
  homeserverUrl: string;
  asToken: string;
}

export function matrixConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MatrixConfig | undefined {
  const homeserverUrl = env.MATRIX_HOMESERVER_URL;
  const asToken = env.MATRIX_AS_TOKEN;
  return homeserverUrl && asToken ? { homeserverUrl, asToken } : undefined;
}

interface SendMatrixMessageInput {
  roomId: string;
  text: string;
}

interface MatrixSendResponse {
  event_id?: string;
  errcode?: string;
  error?: string;
}

export type PostMatrixMessageResult = { ok: true; eventId?: string } | { ok: false; error: string };

/**
 * The raw send-event call, shared by this tool and the inbound Matrix
 * channel transaction handler (see @finanfa/web-server's
 * channels-matrix.ts) so neither duplicates the URL shape/error handling.
 * A fresh random txnId per call — the Client-Server API's own dedup key
 * for an event send, distinct from an Application Service transaction's
 * txnId (a different, inbound-only concept — see matrix-event.ts).
 */
export async function postMatrixMessage(config: MatrixConfig, input: { roomId: string; text: string }, apiBaseUrl = config.homeserverUrl): Promise<PostMatrixMessageResult> {
  const txnId = randomUUID();
  const url = `${apiBaseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/send/m.room.message/${txnId}`;
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(url, {
      method: "PUT",
      headers: { authorization: `Bearer ${config.asToken}`, "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "m.text", body: input.text }),
    }));
  } catch (err) {
    return { ok: false, error: `Failed to reach the Matrix homeserver: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: MatrixSendResponse;
  try {
    data = JSON.parse(bodyText) as MatrixSendResponse;
  } catch {
    return { ok: false, error: `Matrix homeserver returned an unparseable response (HTTP ${response.status}).` };
  }

  if (!response.ok || !data.event_id) return { ok: false, error: data.error ?? `Matrix homeserver error (HTTP ${response.status})` };
  return { ok: true, eventId: data.event_id };
}

export function createSendMatrixMessageTool(config: MatrixConfig | undefined): ToolDefinition<SendMatrixMessageInput> {
  return {
    name: "send_matrix_message",
    description:
      "Send a real message to a Matrix room via the Client-Server API, as the configured Application Service. " +
      "Requires MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN as environment variables — this tool never takes " +
      "credentials as input. IMPORTANT: this posts a real, visible message to a real room — confirm the " +
      "room/content with the user before calling this unless they've explicitly asked for this exact message.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string", description: 'Matrix room id, e.g. "!abc123:example.org"' },
        text: { type: "string", description: "Message text" },
      },
      required: ["roomId", "text"],
    },
    describeCall: (input) => `send Matrix message to ${input.roomId}: "${input.text.slice(0, 60)}"`,
    async handler(input) {
      if (!config) {
        return { content: "Matrix is not configured — set MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN as environment variables to enable send_matrix_message.", isError: true };
      }
      const result = await postMatrixMessage(config, input);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `Message sent to ${input.roomId}${result.eventId ? ` (event_id: ${result.eventId})` : ""}.`, isError: false };
    },
  };
}
