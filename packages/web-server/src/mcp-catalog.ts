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
export const MCP_CATALOG: McpServerConfig[] = [
  { name: "github", transport: "stdio", command: "docker", args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"] },
  { name: "notion", transport: "http", url: "https://mcp.notion.com/mcp" },
  { name: "canva", transport: "http", url: "https://mcp.canva.com/mcp" },
  { name: "supabase", transport: "http", url: "https://mcp.supabase.com/mcp" },
  { name: "gamma", transport: "http", url: "https://mcp.gamma.app/mcp" },
  { name: "vercel", transport: "http", url: "https://mcp.vercel.com" },
];
