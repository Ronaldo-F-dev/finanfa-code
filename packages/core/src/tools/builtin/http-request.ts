import type { ToolDefinition } from "../../core/types.js";
import { wrapUntrustedContent } from "../../core/untrusted-content.js";
import { truncateOrSpill, TRUNCATE_SMALL } from "../../util/truncate.js";

const DEFAULT_TIMEOUT_MS = 30_000;

interface HttpRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
}

export const httpRequestTool: ToolDefinition<HttpRequestInput> = {
  name: "http_request",
  description:
    "Send an HTTP request with any method (GET/POST/PUT/PATCH/DELETE/...), headers, and body — for testing an " +
    "API endpoint (e.g. an app you're developing, running locally or elsewhere), not for reading a web page " +
    "(use web_fetch for that; it also strips HTML, which this doesn't). Returns status, headers, and body.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Request URL" },
      method: { type: "string", description: "HTTP method (default GET)" },
      headers: { type: "object", additionalProperties: { type: "string" }, description: "Request headers" },
      body: { type: "string", description: "Request body (e.g. a JSON string) — set a Content-Type header yourself" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 30000)" },
    },
    required: ["url"],
  },
  riskKey: (input) => `${input.method ?? "GET"} ${input.url}`,
  describeCall: (input) => `${input.method ?? "GET"} ${input.url}`,
  async handler(input, ctx) {
    let response: Response;
    try {
      response = await fetch(input.url, {
        method: input.method ?? "GET",
        headers: input.headers,
        body: input.body,
        redirect: "follow",
        signal: AbortSignal.timeout(input.timeout_ms ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }

    const headerLines = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    const bodyText = await response.text();
    const truncatedBody = await truncateOrSpill(ctx.cwd, ctx.sessionId, "http-body", bodyText, TRUNCATE_SMALL);
    const content = `HTTP ${response.status} ${response.statusText}\n${headerLines}\n\n${truncatedBody}`;

    return { content: wrapUntrustedContent(input.url, content), isError: !response.ok };
  },
};
