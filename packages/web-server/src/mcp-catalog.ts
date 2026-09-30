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
//
// Stripe, QuickBooks, Xero, and Plaid were all investigated for this
// finance/accounting pass and NONE were added to this ONE-CLICK catalog —
// every one needs a real per-user secret (an API key or a client_id
// manually pre-registered in that provider's own developer portal), so
// there's no single shared/built-in credential this catalog mechanism
// could offer the way ms-365-mcp-server's built-in Azure AD app does.
//
// This investigation did surface a real, separate, now-fixed gap:
// McpServerConfig (core/src/mcp/config.ts) had no `env` field at all for
// stdio servers, only `command`/`args` — so even a user who DID have real
// Stripe/Xero/Plaid credentials in hand couldn't wire them in via their own
// hand-edited `.finanfa-code/mcp.json`, since several of these servers only
// read credentials from the environment, not a CLI flag. Fixed: `env` is
// now a real field on McpServerConfig, merged onto the transport's own
// default-safe-to-inherit environment at spawn time (client-manager.ts) —
// confirmed for real (packages/core/test/mcp/client-manager.test.ts) that a
// custom env value reaches the spawned process AND that PATH/etc. survive
// the merge, and confirmed against a real `npx @stripe/mcp` invocation that
// a placeholder STRIPE_SECRET_KEY now gets picked up (past the "key not
// provided" crash, into a real 401 from Stripe's own server — proving the
// key really was received, just not valid). This doesn't make any of these
// four one-click-catalog-eligible (still no shared credential to ship), but
// a user can now add e.g. `{"name": "stripe", "transport": "stdio",
// "command": "npx", "args": ["--package=@stripe/mcp@latest", "mcp"], "env":
// {"STRIPE_SECRET_KEY": "sk_..."}}` to their own mcp.json and have it
// actually work — which was flatly impossible before this fix, regardless
// of catalog membership.
//
// Stripe: real official package `@stripe/mcp` on npm (confirmed via real
// `npm view @stripe/mcp`, v0.3.3, maintained by stripe.com employees). Its
// own README documents `npx -y @stripe/mcp --api-key=YOUR_STRIPE_SECRET_KEY`
// (or STRIPE_SECRET_KEY env var). Tested both ways for real in this sandbox:
// (1) with zero key set, a real
// `npx --package=@stripe/mcp@latest mcp` invocation crashed immediately with
// "Error: Stripe API key not provided..." — zero MCP response, not even a
// process that stays up. (2) with a placeholder key
// (`--api-key=sk_test_placeholder`), it printed "✅ Stripe MCP Server running
// on stdio" but then every message it forwarded to Stripe's real remote
// endpoint (this "local" server is actually a stdio-to-HTTP proxy in front
// of mcp.stripe.com) came back with a real 401:
// `{"error":"Unauthorized...","error_code":"invalid_api_key"}` — no
// `initialize` response ever reached stdout either way. Requires a real
// Stripe secret/restricted key to do anything, and finanfa-code has no
// config surface for a per-server secret. Not added.
//
// QuickBooks: two real options, neither added.
// (a) `quickbooks-mcp` (github.com/laf-rge, confirmed via real `npm view
// quickbooks-mcp`, v0.11.0) — its own README requires the user to first
// register their own app at developer.intuit.com and note a Client
// ID/Secret, then write them into `~/.quickbooks-mcp/credentials.json`
// (its own out-of-band file, not an env var or CLI flag finanfa-code could
// pass). A real `npx --package=quickbooks-mcp@latest quickbooks-mcp`
// invocation in this sandbox with no such file present produced zero
// output on stdout or stderr for the full ~12-second window — the same
// silent-hang failure mode Salesforce's `sf-mcp-server` showed, worse than
// a clean error. (b) Intuit's own official server
// (github.com/intuit/quickbooks-online-mcp-server, referenced from (a)'s
// README) is clone-and-build only, not published to npm — not independently
// verified further since it doesn't clear the "real npx one-click install"
// bar on its own. Neither ships a built-in shared OAuth app the way
// ms-365-mcp-server does; both need a client_id manually pre-registered in
// Intuit's developer portal, the same RFC7591-adjacent gap as gmail/drive.
//
// Xero: official `@xeroapi/xero-mcp-server` on npm (confirmed via real
// `npm view`, v0.0.17, maintainers include @xero.com accounts). Its README's
// two supported auth modes (a Custom Connection client_id/secret, or a
// pre-obtained bearer token) both require XERO_CLIENT_ID/XERO_CLIENT_SECRET
// or XERO_CLIENT_BEARER_TOKEN as *environment variables* — the exact gap
// config.ts has no field for. A real
// `npx --package=@xeroapi/xero-mcp-server@latest xero-mcp-server` invocation
// with none of those set crashed instantly and printed the real error
// "Environment Variables not set - please check your .env file" — zero MCP
// response. No built-in shared app; Xero's Custom Connection model also
// requires the client_id to be manually created in Xero's own developer
// portal first, same gap as QuickBooks/Salesforce/gmail. Not added.
//
// Plaid: `plaid-mcp` on npm (confirmed via real `npm view plaid-mcp`,
// v1.1.1) is sandbox-only per its own description and requires
// PLAID_CLIENT_ID + PLAID_SECRET as environment variables (same config.ts
// gap as Xero above) — disqualifying on its own. It also turned out to be
// broken as published: a real
// `npx --package=plaid-mcp@latest plaid-mcp` invocation in this sandbox
// didn't even reach that credential check — the installed bin
// (`dist/index.js`, an ESM file starting with `import ...` statements) has
// no `#!/usr/bin/env node` shebang, so it was executed as a shell script and
// failed instantly with real errors ("import: command not found", "syntax
// error near unexpected token `('"). Not added.
//
// Mercury, Brex, NetSuite, and SAP were investigated for a follow-up
// finance/accounting pass and NONE were added — same reasoning as the
// Stripe/QuickBooks/Xero/Plaid pass: every real, working server found needs
// a per-user secret with no shared/built-in credential this catalog could
// ship.
//
// Mercury: `mercury-mcp` (confirmed via real `npm view mercury-mcp`,
// v1.0.1, published 2 days before this check by a third party, not
// Mercury/mercury.com itself) documents `MERCURY_API_KEY` as a required env
// var (real per-user API key — same shape as Stripe) and also gates two of
// its tools behind a separate paid "MCP_LICENSE_KEY" from a third-party
// marketplace, per its own README. Moot either way: a real
// `npx --package=mercury-mcp@latest mercury-mcp` invocation in this sandbox
// never got that far — the installed bin (`import ...` ESM source) has no
// `#!/usr/bin/env node` shebang, so it ran as a shell script and failed
// instantly with the identical real errors seen for `plaid-mcp` above
// ("import: command not found", "syntax error near unexpected token `('").
// No other `mercury*mcp*` name resolves on npm (`@mercury/mcp`,
// `mercury-bank-mcp`, `mcp-mercury` all real 404s). Not added.
//
// Brex: two real packages, same maintainer, same result. `mcp-brex`
// (confirmed via real `npm view mcp-brex`, v0.4.0) is the current name;
// `brex-mcp-server` (confirmed via real `npm view brex-mcp-server`, v0.2.0)
// is the same project, deprecated in favor of it per npm's own deprecation
// notice. Its README documents `BREX_API_KEY` as a required env var (a real
// per-user Brex API key, no shared/built-in credential). A real
// `npx --package=mcp-brex@latest mcp-brex` invocation in this sandbox with
// no key set crashed instantly and cleanly with the real error "Missing
// required environment variables: BREX_API_KEY" — zero MCP response, same
// disqualifying shape as Xero. Not added.
//
// NetSuite: three real packages found, all disqualified the same way —
// each needs credentials manually created in the user's own NetSuite
// account before any tool call can work, with no shared/built-in app.
// (a) `netsuite-mcp-server` (confirmed via real `npm view`, v1.0.2) — OAuth
// 1.0 Token-Based Auth requiring an Integration record + Access Token
// created via NetSuite's own Setup UI (Consumer Key/Secret, Token
// ID/Secret). Notably, a real
// `npx --package=netsuite-mcp-server@latest netsuite-mcp-server` invocation
// in this sandbox with zero env vars set DID complete a real MCP handshake
// (`initialize` → real serverInfo, `tools/list` → 11 real tools including
// `test_connection`) — it only fails once a tool is actually called against
// NetSuite, same "clean handshake, then needs a real per-user secret" shape
// as Stripe's `--api-key` path, not a shared credential this catalog could
// supply. (b) `netsuite-mcp` (github.com/samson10504, confirmed via real
// `npm view`, v0.1.1) requires the same OAuth 1.0 TBA fields via
// NETSUITE_* env vars and fails fast and cleanly without them (real error:
// "Missing required NetSuite configuration: NETSUITE_ACCOUNT_ID,
// NETSUITE_CONSUMER_KEY, ..."). (c) `@suiteinsider/netsuite-mcp`
// (confirmed via real npm search listing, v1.0.2) uses OAuth 2.0 PKCE
// instead, but its own README requires first installing a "NetSuite AI
// Connector SuiteApp" in the account and manually creating an OAuth 2.0
// Integration record to obtain a Client ID — the same manual
// pre-registration gap as (a)/(b), just via a different NetSuite screen.
// None added.
//
// SAP: broad surface, two real packages found, neither added.
// (a) `@sap-ux/fiori-mcp-server` (official SAP npm scope, confirmed via
// real `npm view`, v1.14.0) is real and does speak MCP with zero
// credentials — a real invocation of its installed bin
// (`node dist/index.js`, since `npx --yes @sap-ux/fiori-mcp-server@latest
// fiori-mcp` itself produced no output at all in this sandbox for unclear
// reasons) produced a real `initialize` response with serverInfo
// `{"name":"fiori-mcp","version":"1.14.0"}`. But it isn't a finance/
// accounting connector at all: its tools (`generate_fiori_app_*`,
// `list_functionality`, `execute_functionality`) scaffold and modify local
// SAP Fiori UI codebases: an AI coding-assistant dev tool, not a connector
// to live SAP financial data. Its own README says touching a real SAP
// backend requires a "saved SAP system connection" set up out-of-band via
// a separate VS Code extension (Connection Manager for SAP Systems) —
// another credential store finanfa-code has no interface to. Out of scope
// for this catalog even though it's real and unauthenticated at the
// handshake level.
// (b) `sap-datasphere-mcp` (PyPI, confirmed via real PyPI registry JSON,
// v2.0.3) / its npm mirror `@mariodefe/sap-datasphere-mcp` (confirmed via
// real `npm view`, v2.0.3) is a real finance-relevant SAP Datasphere data
// connector, but its own README requires `DATASPHERE_CLIENT_ID` +
// `DATASPHERE_CLIENT_SECRET` — an OAuth 2.0 "technical user" client that
// must be manually registered per-tenant in SAP BTP cockpit — the same
// pre-registered-app gap as Salesforce/QuickBooks/NetSuite above. Not
// added.
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
