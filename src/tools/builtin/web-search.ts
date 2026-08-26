import type { ToolDefinition } from "../../core/types.js";

interface WebSearchInput {
  query: string;
  count?: number;
}

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
}

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

async function braveSearch(query: string, count: number, apiKey: string): Promise<string> {
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));

  const response = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Brave Search API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as BraveSearchResponse;
  const results = data.web?.results ?? [];
  if (results.length === 0) return "(no results)";

  return results
    .slice(0, count)
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
    .join("\n\n");
}

export const webSearchTool: ToolDefinition<WebSearchInput> = {
  name: "web_search",
  description:
    "Search the web for current information (docs, news, package versions, error messages, etc.) using the Brave Search API. Requires the BRAVE_API_KEY environment variable.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      count: { type: "number", description: "Number of results to return (default 5, max 20)" },
    },
    required: ["query"],
  },
  describeCall: (input) => `search "${input.query}"`,
  async handler(input) {
    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) {
      return {
        content:
          "web_search is not configured: set the BRAVE_API_KEY environment variable " +
          "(free tier available at https://brave.com/search/api/).",
        isError: true,
      };
    }
    const count = Math.min(Math.max(input.count ?? 5, 1), 20);
    const content = await braveSearch(input.query, count, apiKey);
    return { content, isError: false };
  },
};
