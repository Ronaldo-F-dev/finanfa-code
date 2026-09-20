import type { McpServerConfig } from "@finanfa/core/src/mcp/config.js";

// Well-known connectors offered even to a project that hasn't configured
// any MCP server yet — matching what Claude's own Connectors page shows
// (a catalog of known integrations with a Connect button, not just "here's
// what you already wired up"). These exact entries (name/transport/url)
// are the real, previously-verified ones this project's own .finanfa-code/
// mcp.json uses — notion/canva/supabase confirmed working end-to-end;
// gamma/vercel are unverified. Not a guess: copied from a real, working
// config.
//
// gmail/drive were removed from this one-click catalog: their MCP
// endpoints returned a real "Connected" for the initial handshake (no
// token needed yet) but then failed every actual tool call with
// "Incompatible auth server: does not support dynamic client
// registration" — confirmed against a real account, not a guess. Google's
// OAuth server doesn't support the RFC7591 dynamic client registration
// finanfa-code's OAuth flow relies on (unlike Notion/Canva/Supabase); it
// requires a client_id manually pre-registered in Google Cloud Console,
// which finanfa-code has no config surface for yet. Re-add here once that
// support exists — until then this catalog entry would just repeat the
// same misleading "Connected" → later failure for every user.
// github was tried twice in this one-click catalog and removed both times:
// first `ghcr.io/github/github-mcp-server` via `docker run` (real, reported
// bug — nothing in this project lets a user set
// GITHUB_PERSONAL_ACCESS_TOKEN, and it failed instantly with "MCP error
// -32000: connection closed" whenever Docker Desktop wasn't already
// running), then api.githubcopilot.com/mcp/'s OAuth (real, reported bug —
// "Incompatible auth server: does not support dynamic client registration",
// the exact same RFC7591 gap documented below for gmail/drive: it needs a
// client_id pre-registered as a real GitHub OAuth App, which finanfa-code
// has no config surface for yet). Re-add once one of those two gaps is
// actually closed — until then either option just repeats a guaranteed
// failure for every user.
export const MCP_CATALOG: McpServerConfig[] = [
  { name: "notion", transport: "http", url: "https://mcp.notion.com/mcp" },
  { name: "canva", transport: "http", url: "https://mcp.canva.com/mcp" },
  { name: "supabase", transport: "http", url: "https://mcp.supabase.com/mcp" },
  { name: "gamma", transport: "http", url: "https://mcp.gamma.app/mcp" },
  { name: "vercel", transport: "http", url: "https://mcp.vercel.com" },
  // Hostinger's own hostinger-api-mcp package (https://github.com/hostinger/api-mcp-server)
  // — each of these 5 is a separate real npx-launched stdio server (one
  // process per domain area, not one server exposing everything), all
  // confirmed connecting end-to-end via a real npx invocation (real
  // MCP initialize handshake, real tool list: 73/41/8/9/52 tools
  // respectively) — not a guess at the package's shape.
  { name: "hostinger-hosting", transport: "stdio", command: "npx", args: ["--package=hostinger-api-mcp@latest", "hostinger-hosting-mcp"] },
  { name: "hostinger-domains", transport: "stdio", command: "npx", args: ["--package=hostinger-api-mcp@latest", "hostinger-domains-mcp"] },
  { name: "hostinger-dns", transport: "stdio", command: "npx", args: ["--package=hostinger-api-mcp@latest", "hostinger-dns-mcp"] },
  { name: "hostinger-billing", transport: "stdio", command: "npx", args: ["--package=hostinger-api-mcp@latest", "hostinger-billing-mcp"] },
  { name: "hostinger-reach", transport: "stdio", command: "npx", args: ["--package=hostinger-api-mcp@latest", "hostinger-reach-mcp"] },
];
