import type { ToolDefinition } from "../../core/types.js";

interface WebFetchInput {
  url: string;
}

const MAX_CONTENT_LENGTH = 8000;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export const webFetchTool: ToolDefinition<WebFetchInput> = {
  name: "web_fetch",
  description:
    "Fetch a specific URL and return its text content (HTML tags stripped) — text only, you will not see how " +
    "the page actually looks. Use this when the user gives you a link or you already know the exact page to " +
    "read; for open-ended searching, use web_search instead. If the user wants to see, describe the appearance " +
    "of, or capture/screenshot a page, use browser_navigate + browser_screenshot instead, not this tool.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "The URL to fetch" } },
    required: ["url"],
  },
  describeCall: (input) => `fetch ${input.url}`,
  async handler(input) {
    const response = await fetch(input.url, { redirect: "follow" });
    if (!response.ok) {
      return { content: `Failed to fetch ${input.url}: HTTP ${response.status}`, isError: true };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    const text = contentType.includes("html") ? stripHtml(raw) : raw.trim();
    const truncated = text.length > MAX_CONTENT_LENGTH ? `${text.slice(0, MAX_CONTENT_LENGTH)}\n... (truncated)` : text;

    return { content: truncated || "(empty response)", isError: false };
  },
};
