import type { ToolDefinition } from "../../core/types.js";
import { wrapUntrustedContent } from "../../core/untrusted-content.js";

interface WebSearchInput {
  query: string;
  count?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const USER_AGENT = "Mozilla/5.0 (compatible; finanfa-code/0.1)";

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

/** DuckDuckGo's HTML results wrap the real URL in a redirect link's `uddg` query param. */
function resolveResultUrl(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : href;
  } catch {
    return href;
  }
}

function extractResults(html: string, count: number): SearchResult[] {
  const linkRegex = /<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const links: { url: string; title: string }[] = [];
  for (const match of html.matchAll(linkRegex)) {
    if (links.length >= count) break;
    links.push({ url: resolveResultUrl(match[1]), title: stripTags(match[2]) });
  }

  const snippets: string[] = [];
  for (const match of html.matchAll(snippetRegex)) {
    if (snippets.length >= count) break;
    snippets.push(stripTags(match[1]));
  }

  return links.map((link, i) => ({ ...link, snippet: snippets[i] ?? "" }));
}

async function duckDuckGoSearch(query: string, count: number): Promise<string> {
  const url = new URL(DDG_HTML_ENDPOINT);
  url.searchParams.set("q", query);

  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`DuckDuckGo search error (${response.status})`);
  }

  const html = await response.text();
  const results = extractResults(html, count);
  if (results.length === 0) return "(no results)";

  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
}

export const webSearchTool: ToolDefinition<WebSearchInput> = {
  name: "web_search",
  description:
    "Search the web for current information (docs, news, package versions, error messages, etc.) via DuckDuckGo — free, no API key required.",
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
    const count = Math.min(Math.max(input.count ?? 5, 1), 20);
    const content = await duckDuckGoSearch(input.query, count);
    return {
      content: content === "(no results)" ? content : wrapUntrustedContent(`web_search: ${input.query}`, content),
      isError: false,
    };
  },
};
