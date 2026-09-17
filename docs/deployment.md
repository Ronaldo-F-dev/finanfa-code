# Deployment

## Docker

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build
```

Serves the same web app on `http://localhost:4600`. `./workspace` on the
host is the agent's project directory inside the container;
`~/.finanfa-code` config/sessions persist in a named volume across
restarts. Set `FINANFA_PROVIDER`/`FINANFA_BASE_URL`/`FINANFA_MODEL`/`FINANFA_API_KEY`
instead of `ANTHROPIC_API_KEY` for an OpenAI-compatible backend.

## Fly.io / Render.com

Both build the same [Dockerfile](../Dockerfile) — nothing extra to
write, just a hosting target for it:

- **[fly.toml](../fly.toml)**: `fly launch --no-deploy` (creates/renames
  the app), `fly volumes create finanfa_data --size 1 --region <region>`
  (persists `~/.finanfa-code` across deploys), `fly secrets set ANTHROPIC_API_KEY=...`,
  `fly deploy`.
- **[render.yaml](../render.yaml)**: in the Render dashboard, "New +" →
  "Blueprint", point it at this repo — Render reads the file and creates
  the service; set `ANTHROPIC_API_KEY` as a real secret in the service's
  Environment tab afterward (deliberately not committed to the file).

Either way, the project directory itself (`/workspace` inside the
container) is **not** persisted by default — only `~/.finanfa-code`
(sessions/config/memory) is. Mount a second volume/disk at `/workspace`
if the checkout itself should survive a restart too.

## Multi-user access (Gateway)

By default the web server is fully open — anyone who can reach it can
drive any session, same as any other local-dev tool.

### Static shared tokens

```bash
export FINANFA_WEB_USERS="alice:some-long-random-token,bob:another-long-random-token"
npm run dev:web-server
```

Every `/api/*` request then needs `Authorization: Bearer <token>`
(inbound channel webhooks are unaffected — they have their own signature
verification); the WebSocket connection needs a `?token=` query param. A
session created under one user's token is invisible to (and can't be
resumed or deleted by) another's — `GET /api/sessions` only lists your
own, `DELETE /api/sessions/:id` 403s on someone else's. A session with no
owner recorded (predates this feature, or was created by the CLI/VS
Code/ACP) is unclaimed — the first user to resume it adopts it.

### Real per-login accounts

Independent of `FINANFA_WEB_USERS` — either can be used alone, or both
together:

```bash
export FINANFA_WEB_ACCOUNTS=1
npm run dev:web-server

# first account ever needs no auth to create (bootstrap) — every one after that does:
curl -X POST http://localhost:4600/api/auth/users -H 'content-type: application/json' -d '{"username":"alice","password":"a-real-password"}'
curl -X POST http://localhost:4600/api/auth/login -H 'content-type: application/json' -d '{"username":"alice","password":"a-real-password"}'
# -> {"token": "...", "user": "alice"} — use that token exactly like a static FINANFA_WEB_USERS one
```

Passwords are hashed (scrypt, random salt) and persisted to
`~/.finanfa-code/web-users.json` — the plain password is never stored. A
login's session token (30-day expiry) is persisted to
`~/.finanfa-code/web-sessions.json`, so a server restart doesn't force
everyone to log in again. Once logged in, alice can create further
accounts (`POST /api/auth/users` with her own token) without a shared
secret handed to her out of band.

### SSO (OIDC)

Log in with Google/Okta/any real OIDC provider:

```bash
export FINANFA_WEB_OIDC_ISSUER=...
export FINANFA_WEB_OIDC_CLIENT_ID=...
export FINANFA_WEB_OIDC_CLIENT_SECRET=...
export FINANFA_WEB_OIDC_REDIRECT_URI=https://<your-server>/api/auth/oidc/callback
```

Register the redirect URI with your provider. A real Authorization Code
+ PKCE flow: visiting `GET /api/auth/oidc/login` redirects to the
provider; after login it redirects back to `/#token=...&user=...` (a URL
fragment — never sent to the server, so it can't leak via
logs/Referer) with a session token that authenticates identically to a
password login's.

This covers real authentication and per-user session isolation within
one web-server process — not a separate control-plane service
coordinating multiple downstream agent instances, and not per-user
isolation of the underlying project/workspace files themselves (every
authenticated user shares the same projects on disk; only conversation
history is private).
