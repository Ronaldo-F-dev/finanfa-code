import type { ToolDefinition } from "../../core/types.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool for Trello (another of the productivity
// integrations — Notion/Trello/Spotify/... — flagged as a gap relative
// to a comparable project we audited against, see notion.ts). Trello's
// REST API authenticates via a key+token pair as query params (not a
// bearer header like Slack/Notion), issued from https://trello.com/app-key
// and a one-time authorize link — both are long-lived until the user
// revokes them from their Trello account.
const TRELLO_API_BASE = "https://api.trello.com/1";

export interface TrelloConfig {
  apiKey: string;
  token: string;
}

export function trelloConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TrelloConfig | undefined {
  const apiKey = env.TRELLO_API_KEY;
  const token = env.TRELLO_API_TOKEN;
  return apiKey && token ? { apiKey, token } : undefined;
}

function parseRetryAfterHeaderMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export type CreateTrelloCardResult = { ok: true; id: string; url: string } | { ok: false; error: string };

/** Shared by the tool below. Trello's error bodies are often a plain-text string (not JSON) on a 400/401 — unlike Slack/Notion's structured error shape — so a failed JSON.parse there falls back to the raw response text rather than treating it as a hard failure. */
export async function createTrelloCard(
  config: TrelloConfig,
  input: { listId: string; name: string; desc?: string },
  apiBaseUrl = TRELLO_API_BASE,
): Promise<CreateTrelloCardResult> {
  const params = new URLSearchParams({ idList: input.listId, name: input.name, key: config.apiKey, token: config.token });
  if (input.desc) params.set("desc", input.desc);

  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(`${apiBaseUrl}/cards?${params.toString()}`, { method: "POST" }, { retryAfterMs: parseRetryAfterHeaderMs }));
  } catch (err) {
    return { ok: false, error: `Failed to reach Trello: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: { id?: string; url?: string; shortUrl?: string; message?: string } | undefined;
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    data = undefined;
  }

  if (!response.ok) {
    return { ok: false, error: data?.message || bodyText.trim() || `Trello API error (HTTP ${response.status})` };
  }
  if (!data?.id) return { ok: false, error: `Trello returned an unparseable response (HTTP ${response.status}).` };
  return { ok: true, id: data.id, url: data.shortUrl ?? data.url ?? "" };
}

interface CreateTrelloCardInput {
  list_id: string;
  name: string;
  desc?: string;
}

export function createCreateTrelloCardTool(config: TrelloConfig | undefined, apiBaseUrl = TRELLO_API_BASE): ToolDefinition<CreateTrelloCardInput> {
  return {
    name: "create_trello_card",
    description:
      "Create a real card on a Trello list, via the real Trello REST API. Requires TRELLO_API_KEY and " +
      "TRELLO_API_TOKEN to be configured as environment variables (from https://trello.com/app-key, plus a " +
      "one-time token authorization) — this tool never takes credentials as input. " +
      "IMPORTANT: this creates a real, visible card on a real board — confirm the list/content with the user " +
      "before calling this unless they've explicitly asked for this exact card.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "Trello list id to add the card to (from the list's own URL/API, not the board id)" },
        name: { type: "string", description: "Card title" },
        desc: { type: "string", description: "Card description (optional)" },
      },
      required: ["list_id", "name"],
    },
    describeCall: (input) => `create Trello card "${input.name}" on list ${input.list_id}`,
    async handler(input) {
      if (!config) return { content: "Trello is not configured — set TRELLO_API_KEY and TRELLO_API_TOKEN as environment variables to enable create_trello_card.", isError: true };
      const result = await createTrelloCard(config, { listId: input.list_id, name: input.name, desc: input.desc }, apiBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `Created Trello card "${input.name}"${result.url ? ` (${result.url})` : ""}.`, isError: false };
    },
  };
}
