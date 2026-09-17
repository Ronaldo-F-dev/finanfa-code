import type { ToolDefinition } from "../../core/types.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool for Notion (one of the productivity integrations
// a comparable project we audited against has and this one lacked) — the
// real Notion REST API, using an internal integration token so it can
// read/write any page that token has been explicitly shared with in the
// user's own workspace. No SDK dependency: two authenticated HTTP calls,
// same shape as send-slack-message.ts.
//
// Credentials come from env vars (NOTION_API_KEY), never from tool
// input. Notion's API requires a Notion-Version header pinning the wire
// format version — 2022-06-28 is the latest stable version as of this
// writing and the one the block/rich_text shapes below assume.
const NOTION_VERSION = "2022-06-28";
const NOTION_API_BASE = "https://api.notion.com/v1";

export interface NotionConfig {
  apiKey: string;
}

export function notionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NotionConfig | undefined {
  const apiKey = env.NOTION_API_KEY;
  return apiKey ? { apiKey } : undefined;
}

interface NotionRichText {
  plain_text: string;
}

interface NotionBlock {
  type: string;
  [key: string]: unknown;
}

interface NotionErrorBody {
  message?: string;
}

function parseRetryAfterHeaderMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** Extracts a block's own rich_text (its type-named property, e.g. `paragraph.rich_text`, `heading_1.rich_text`) as plain text — every text-bearing block type shares this rich_text shape, so this doesn't need a case per block type. */
function blockPlainText(block: NotionBlock): string {
  const typedContent = block[block.type] as { rich_text?: NotionRichText[] } | undefined;
  return typedContent?.rich_text?.map((rt) => rt.plain_text).join("") ?? "";
}

export type ReadNotionPageResult = { ok: true; text: string; hasMore: boolean } | { ok: false; error: string };

/** Shared by the tool below — retrieves a page (or any block)'s direct children and flattens their text, one line per block. Notion nests deeper content (a toggle's own children, a sub-page) behind a further request per block; this reads one level, which covers the common "read this page's body text" case. */
export async function readNotionPageBlocks(config: NotionConfig, blockId: string, apiBaseUrl = NOTION_API_BASE): Promise<ReadNotionPageResult> {
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(
      `${apiBaseUrl}/blocks/${encodeURIComponent(blockId)}/children?page_size=100`,
      { method: "GET", headers: { Authorization: `Bearer ${config.apiKey}`, "Notion-Version": NOTION_VERSION } },
      { retryAfterMs: parseRetryAfterHeaderMs },
    ));
  } catch (err) {
    return { ok: false, error: `Failed to reach Notion: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: { results?: NotionBlock[]; has_more?: boolean } & NotionErrorBody;
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    return { ok: false, error: `Notion returned an unparseable response (HTTP ${response.status}).` };
  }
  if (!response.ok) return { ok: false, error: data.message ?? `Notion API error (HTTP ${response.status})` };

  const text = (data.results ?? [])
    .map(blockPlainText)
    .filter((line) => line.length > 0)
    .join("\n");
  return { ok: true, text, hasMore: data.has_more === true };
}

export type AppendNotionTextResult = { ok: true } | { ok: false; error: string };

/** Appends one paragraph block per line of `text` as children of `blockId` (a page id works too — Notion treats a page as the root block of its own content). */
export async function appendNotionParagraphs(config: NotionConfig, blockId: string, text: string, apiBaseUrl = NOTION_API_BASE): Promise<AppendNotionTextResult> {
  const children = text.split("\n").map((line) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
  }));

  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(
      `${apiBaseUrl}/blocks/${encodeURIComponent(blockId)}/children`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Notion-Version": NOTION_VERSION, "content-type": "application/json" },
        body: JSON.stringify({ children }),
      },
      { retryAfterMs: parseRetryAfterHeaderMs },
    ));
  } catch (err) {
    return { ok: false, error: `Failed to reach Notion: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: NotionErrorBody;
  try {
    data = JSON.parse(bodyText) as NotionErrorBody;
  } catch {
    return { ok: false, error: `Notion returned an unparseable response (HTTP ${response.status}).` };
  }
  if (!response.ok) return { ok: false, error: data.message ?? `Notion API error (HTTP ${response.status})` };
  return { ok: true };
}

interface ReadNotionPageInput {
  page_id: string;
}

export function createReadNotionPageTool(config: NotionConfig | undefined, apiBaseUrl = NOTION_API_BASE): ToolDefinition<ReadNotionPageInput> {
  return {
    name: "read_notion_page",
    description:
      "Read a Notion page's (or block's) direct content as plain text, via the real Notion API. Requires " +
      "NOTION_API_KEY (an internal integration token, shared with the target page in Notion's own UI) to be " +
      "configured as an environment variable — this tool never takes credentials as input. Reads one level of " +
      "content (a nested toggle/sub-page's own content isn't recursed into) and the first 100 blocks.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: { page_id: { type: "string", description: "Notion page id (or any block id) — the UUID from the page's own URL" } },
      required: ["page_id"],
    },
    describeCall: (input) => `read Notion page ${input.page_id}`,
    async handler(input) {
      if (!config) return { content: "Notion is not configured — set NOTION_API_KEY as an environment variable to enable read_notion_page.", isError: true };
      const result = await readNotionPageBlocks(config, input.page_id, apiBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };
      const truncationNote = result.hasMore ? "\n\n(more content exists beyond the first 100 blocks — not fetched)" : "";
      return { content: (result.text || "(this page has no readable text content)") + truncationNote, isError: false };
    },
  };
}

interface WriteNotionPageInput {
  page_id: string;
  text: string;
}

export function createWriteNotionPageTool(config: NotionConfig | undefined, apiBaseUrl = NOTION_API_BASE): ToolDefinition<WriteNotionPageInput> {
  return {
    name: "write_notion_page",
    description:
      "Append plain-text content to a Notion page (or block), via the real Notion API — one paragraph block per " +
      "line of the given text. Requires NOTION_API_KEY (an internal integration token, shared with the target " +
      "page in Notion's own UI) to be configured as an environment variable. " +
      "IMPORTANT: this writes real, visible content to a real Notion page — confirm the page/content with the " +
      "user before calling this unless they've explicitly asked for this exact content.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "Notion page id (or any block id) — the UUID from the page's own URL" },
        text: { type: "string", description: "Plain text to append; each line becomes its own paragraph block" },
      },
      required: ["page_id", "text"],
    },
    describeCall: (input) => `append to Notion page ${input.page_id}: "${input.text.slice(0, 60)}"`,
    async handler(input) {
      if (!config) return { content: "Notion is not configured — set NOTION_API_KEY as an environment variable to enable write_notion_page.", isError: true };
      const result = await appendNotionParagraphs(config, input.page_id, input.text, apiBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `Appended to Notion page ${input.page_id}.`, isError: false };
    },
  };
}
