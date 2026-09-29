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
//
// Anaplan was investigated (github.com/larasrinath/anaplan-mcp, "MCP server
// for Anaplan Integration API v2") and NOT added: it is not published to
// npm — confirmed by a real `npm view` against the registry for both
// `anaplan-mcp` and `@larasrinath/anaplan-mcp`, each returning a real
// "404 Not Found" — despite third-party mirror sites (glama.ai, playbooks,
// lobehub) describing an `npx -y @larasrinath/anaplan-mcp` invocation that
// does not actually resolve. The project's real README only documents
// `git clone` + `npm run build` + `node dist/index.js` against a local
// checkout path, which isn't a command any user's environment can run
// one-click the way `npx --package=X@latest bin` is. Re-add if/when it's
// published to npm with a real package name.
//
// Salesforce was investigated via both of its real options and neither was
// added:
// (a) github.com/salesforcecli/mcp, published as `@salesforce/mcp` on npm
// (confirmed via real `npm view`, v0.30.15) — but a real
// `npx --package=@salesforce/mcp@latest sf-mcp-server --orgs
// DEFAULT_TARGET_ORG --toolsets all` invocation in this sandbox (no `sf`
// CLI installed, no authenticated org, matching a fresh user's machine)
// never produced any MCP response at all — no initialize reply, no error,
// no process exit — after 55+ real seconds, and a direct invocation of the
// installed bin confirmed the install/bin were incomplete
// (`ENOENT` on `sf-mcp-server`). Real, reproduced: this hangs silently with
// zero MCP handshake rather than erroring cleanly, worse than a "Connected
// then fails" case — do not add until it can be confirmed to at least
// speak MCP over stdio without a pre-installed `sf` CLI + pre-authenticated
// org.
// (b) Salesforce's official Hosted MCP Servers (http/OAuth,
// developer.salesforce.com/docs/platform/hosted-mcp-servers) — confirmed
// via Salesforce's own real documentation
// (client-connection-overview.html, create-external-client-app.html):
// Salesforce does NOT support RFC7591 dynamic client registration for
// these; an admin must manually create a pre-registered "External Client
// App" (client_id) in their org first. This is the exact same
// oauth-provider.ts gap documented above for gmail/drive/github — do not
// add as an `http` catalog entry until finanfa-code has a config surface
// for a manually pre-registered client_id.
//
// Microsoft 365 / Word: two community servers were investigated.
// github.com/Aanerud/MCP-Microsoft-Office was NOT added — its own real
// README requires the user to manually create an Azure AD App Registration
// and supply MICROSOFT_CLIENT_ID/MICROSOFT_TENANT_ID before any auth flow
// works at all (same pre-registered-client_id gap as above), and it isn't
// published to npm (clone + `npm run dev:web` only).
// github.com/Softeria/ms-365-mcp-server IS added below: published on npm as
// `@softeria/ms-365-mcp-server` (confirmed via real `npm view`, v0.157.0)
// and ships its own built-in default Azure AD app — no user-supplied
// client_id needed, auth happens via an in-band `login` tool (device code
// flow) after the server is already running, so finanfa-code's own OAuth
// client (oauth-provider.ts) is never involved. Confirmed connecting
// end-to-end via a real
// `npx --package=@softeria/ms-365-mcp-server@latest ms-365-mcp-server`
// invocation in this sandbox with zero pre-configuration: a real MCP
// `initialize` handshake succeeded (serverInfo
// `{"name":"Microsoft365MCP","version":"0.157.0"}`), followed by a real
// `tools/list` response: 183 tools (Mail/Calendar/Teams/OneDrive/
// SharePoint/Word/Excel/PowerPoint via Microsoft Graph). Actually calling
// those tools still requires the user to run the `login` tool and complete
// the device-code flow in a browser — not verified end-to-end with a real
// Microsoft account — but the connector itself starts and speaks real MCP
// with no credentials, same bar hostinger's entries were held to.
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
  { name: "microsoft-365", transport: "stdio", command: "npx", args: ["--package=@softeria/ms-365-mcp-server@latest", "ms-365-mcp-server"] },
];
