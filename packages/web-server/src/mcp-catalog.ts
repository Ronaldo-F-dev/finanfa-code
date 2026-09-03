import type { McpServerConfig } from "@finanfa/core/src/mcp/config.js";

// Well-known connectors offered even to a project that hasn't configured
// any MCP server yet — matching what Claude's own Connectors page shows
// (a catalog of known integrations with a Connect button, not just "here's
// what you already wired up"). These exact entries (name/transport/url)
// are the real, previously-verified ones this project's own .finanfa-code/
// mcp.json uses — notion/canva/supabase confirmed working end-to-end;
// gmail/drive need their own one-time Google Cloud OAuth app setup first
// (see the README); gamma/vercel are unverified. Not a guess: copied from
// a real, working config.
export const MCP_CATALOG: McpServerConfig[] = [
  { name: "github", transport: "stdio", command: "docker", args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"] },
  { name: "notion", transport: "http", url: "https://mcp.notion.com/mcp" },
  { name: "canva", transport: "http", url: "https://mcp.canva.com/mcp" },
  { name: "supabase", transport: "http", url: "https://mcp.supabase.com/mcp" },
  { name: "gmail", transport: "http", url: "https://gmailmcp.googleapis.com/mcp/v1" },
  { name: "drive", transport: "http", url: "https://drivemcp.googleapis.com/mcp/v1" },
  { name: "gamma", transport: "http", url: "https://mcp.gamma.app/mcp" },
  { name: "vercel", transport: "http", url: "https://mcp.vercel.com" },
];
