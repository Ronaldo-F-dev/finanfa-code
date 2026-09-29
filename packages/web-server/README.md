# @finanfa/web-server

WebSocket (and REST) server exposing `@finanfa/core` to the browser. The
browser can't spawn subprocesses or touch the filesystem itself, so this
process runs the real agent (tools, sessions, permissions, providers) and
talks to the browser over `/ws` (streaming turns) and a set of `/api/*`
REST endpoints (config, sessions, projects, skills, memory, one-shot
turns via `POST /api/turn`, model/effort-tier management, and the
inbound chat-channel webhooks — see [docs/channels.md](../../docs/channels.md)
for Slack/Telegram/Matrix/LINE/Feishu/Teams/Discord/WhatsApp/SMS/Voice).

## Structure

```
src/
  index.ts                 entry point — express app, WS server, all /api routes
  web-ui-adapter.ts        UIAdapter implementation that streams a turn over the WS connection
  auth.ts                  static-token (FINANFA_WEB_USERS) auth helpers
  user-store.ts            real per-login accounts (hashed passwords)
  session-token-store.ts   issued login/OIDC session tokens, persisted to disk
  oidc.ts                  SSO (OIDC authorization-code + PKCE) login flow
  projects.ts              multi-project directory resolution
  mcp-catalog.ts            catalog used by the web UI's MCP picker
  cloudflare-tunnel.ts      optional `cloudflared` quick tunnel for public webhook URLs
  channels-config-api.ts   the web UI's Channels settings panel
  channels-*.ts            one file per inbound chat channel (Slack, Telegram, Discord, ...)
test/                      vitest, incl. a real WS/subprocess harness (test/support/spawn-server.ts)
```

## Dev

```bash
npm run dev:web-server   # from the repo root, or: npm run dev -w @finanfa/web-server
```

Runs `tsx watch src/index.ts` — restarts on file changes, no build step.

## Production

```bash
npm run start   # tsx src/index.ts, no watch
```

This package has no separate build step of its own (`tsx` runs the
TypeScript directly). See [docs/deployment.md](../../docs/deployment.md)
for the full production story: Docker/Fly.io/Render.com, and the
Gateway multi-user auth options (static tokens, real accounts, OIDC SSO)
also implemented in this package (`auth.ts`, `user-store.ts`, `oidc.ts`).

## Relationship to web-client

`packages/web-client` is a separate Vite/React app built independently
(`npm run build -w @finanfa/web-client`) into `packages/web-client/dist`.
This server serves that built output as static files
(`express.static(clientDist)` in `src/index.ts`, with a catch-all route
falling back to `index.html`) and prints a plain error telling you to
build it first if `dist` doesn't exist yet. In dev, running
`npm run dev:web-client` instead gives you Vite's own dev server (HMR)
proxying to this server's `/api`/`/ws` — the two are separate processes
either way, this one just also happens to be able to serve the other's
production build.

## Environment variables

Read directly in `src/index.ts`:

- `PORT` — HTTP/WS port (default `4600`).
- `FINANFA_WEB_CWD` — default project directory (default `process.cwd()`).
- `FINANFA_WEB_USERS` — `user:token,user:token` static Gateway auth tokens.
- `FINANFA_WEB_ACCOUNTS=1` — enables real per-login password accounts.
- `FINANFA_WEB_OIDC_ISSUER` / `FINANFA_WEB_OIDC_CLIENT_ID` /
  `FINANFA_WEB_OIDC_CLIENT_SECRET` / `FINANFA_WEB_OIDC_REDIRECT_URI` — SSO login.
- `ANTHROPIC_API_KEY` / `ANTHROPIC_WORKSPACE_ID`, `FINANFA_PROVIDER` /
  `FINANFA_BASE_URL` / `FINANFA_MODEL` / `FINANFA_API_KEY` / `FINANFA_API_KEYS` —
  same provider config as the CLI (see [docs/providers.md](../../docs/providers.md)).
- `FINANFA_TUNNEL=1` — opens a `cloudflared` quick tunnel on startup so
  webhook-based channels get a public HTTPS URL automatically.

Any of Gateway's static-token/accounts/OIDC settings can also be set
from the web UI's own Settings/Channels panels instead of exported
env vars; a real env var always wins (see [docs/deployment.md](../../docs/deployment.md)).

## Tests

```bash
npm test   # vitest run — one workspace-wide config, includes packages/web-server/test/
```

Real coverage, not mocked-out: `test/support/spawn-server.ts` spawns an
actual server subprocess and drives it over a real WebSocket connection,
plus per-channel tests, OIDC, gateway auth, and the effort-tier/model
APIs.
