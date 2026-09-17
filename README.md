# finanfa-code

**Real tools, real actions, any machine. Not a chatbot — an operator.**

A from-scratch AI coding agent, in TypeScript, with a terminal UI (Ink) and a browser UI. Pluggable LLM backend: Anthropic, Azure OpenAI, Gemini, Cohere, GitHub Copilot, Amazon Bedrock, Google Vertex AI, or anything speaking the OpenAI chat-completions wire format (Ollama, OpenRouter, Poolside, LM Studio, vLLM, ...).

Requires Node.js **22.5.0+**.

## Setup

### Anthropic (default)

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

### OpenAI-compatible (Ollama, OpenRouter, Poolside, ...)

```bash
export FINANFA_PROVIDER=openai-compatible
export FINANFA_BASE_URL=http://localhost:11434/v1   # or your provider's base URL
export FINANFA_MODEL=llama3.1:8b
export FINANFA_API_KEY=...                           # if the provider needs one
npm run dev
```

Prefer a model with reliable tool-calling support — a model that writes tool calls as plain text instead of a structured response won't actually be able to use any tool. `/cost` reports `$0/0 tokens` for backends that don't return usage in streamed responses; that's expected.

### Azure OpenAI

```bash
export FINANFA_PROVIDER=azure-openai
export FINANFA_BASE_URL=https://my-resource.openai.azure.com   # no trailing path
export FINANFA_MODEL=my-gpt4o-deployment                        # the Azure *deployment* name, not a model name
export FINANFA_API_KEY=...
npm run dev
```

### Gemini

```bash
export FINANFA_PROVIDER=gemini
export FINANFA_API_KEY=...
npm run dev
```

### Cohere

```bash
export FINANFA_PROVIDER=cohere
export FINANFA_API_KEY=...
export FINANFA_MODEL=command-r-plus-08-2024   # optional — this is the default
npm run dev
```

### GitHub Copilot

Requires a GitHub account with Copilot access. Authentication is GitHub's OAuth **device flow** (the same mechanism `gh auth login` uses) — a one-time setup, not a config value you can just paste in from somewhere:

1. Request a device code:
   ```bash
   curl -s -X POST https://github.com/login/device/code \
     -H "content-type: application/json" -H "accept: application/json" \
     -d '{"client_id":"01ab8ac9400c4e429b23","scope":"read:user"}'
   ```
   This returns `device_code`, `user_code`, and `verification_uri`.
2. Open `verification_uri` in a browser and enter the `user_code` shown.
3. Poll for the access token (repeat every `interval` seconds from step 1's response until it stops returning `authorization_pending`):
   ```bash
   curl -s -X POST https://github.com/login/oauth/access_token \
     -H "content-type: application/json" -H "accept: application/json" \
     -d '{"client_id":"01ab8ac9400c4e429b23","device_code":"<device_code from step 1>","grant_type":"urn:ietf:params:oauth:grant-type:device_code"}'
   ```
   Once authorized, this returns `{"access_token": "gho_..."}`.
4. Save it:
   ```bash
   export FINANFA_PROVIDER=github-copilot
   export FINANFA_GITHUB_COPILOT_TOKEN=gho_...   # or /config set githubCopilotToken <token>
   npm run dev
   ```

This GitHub token is exchanged for a short-lived Copilot API token automatically on every turn — it's never sent to `api.githubcopilot.com` directly.

### Amazon Bedrock (Claude via AWS)

```bash
export FINANFA_PROVIDER=amazon-bedrock
export FINANFA_MODEL=anthropic.claude-sonnet-5-20250929-v1:0   # a Bedrock model ID or cross-region inference profile ARN
export AWS_REGION=us-west-2                                      # or FINANFA_AWS_REGION / /config set awsRegion
npm run dev
```

AWS credentials come from the standard AWS credential chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`, `~/.aws/credentials`, an instance/task role, ...) — the same way `aws` CLI commands already authenticate on this machine. Nothing extra to configure unless that chain isn't what should be used here.

### Google Vertex AI (Claude via GCP)

```bash
export FINANFA_PROVIDER=google-vertex
export FINANFA_MODEL=claude-sonnet-5@20250929   # a Vertex publisher model ID
export FINANFA_VERTEX_REGION=us-central1
export FINANFA_VERTEX_PROJECT_ID=my-gcp-project
npm run dev
```

Auth is Google Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS` pointing at a service account key, or `gcloud auth application-default login`).

### Persistent config

```
/config set provider openai-compatible
/config set baseUrl https://inference.poolside.ai/v1
/config set model poolside/laguna-s-2.1
/config set apiKey <your key>
```

Saved to `~/.finanfa-code/config.json` (global) or `.finanfa-code/config.json` (project-local, overrides global). Priority: env var/CLI flag > project config > global config > default. Takes effect on the next run.

## Running

### Terminal (default)

```bash
npm run dev
```

### Browser

Two processes, in two terminals — the server (agent + WebSocket) and the client (Vite dev server) run separately:

```bash
npm run dev:web-server   # terminal 1 — API/WebSocket server on http://localhost:4600
npm run dev:web-client   # terminal 2 — Vite dev server, proxies /api and /ws to the server above
```

Open the URL `dev:web-client` prints (`http://localhost:5173` by default). Same agent, same tools/config as the terminal UI — a chat UI with sessions, projects, MCP/skills/memory panels, and model switching, instead of a terminal.

By default the web server operates on the directory it was started from; point it elsewhere with `FINANFA_WEB_CWD=/path/to/project npm run dev:web-server`, or change the port with `PORT=4601 npm run dev:web-server` (update the proxy target in `packages/web-client/vite.config.ts` to match). For a one-off production build instead of the dev server: `npm run build:web-client`, then `npm run dev:web-server` serves the built client directly — no separate client process needed.

### Multi-user access (Gateway)

By default the web server is fully open — anyone who can reach it can drive any session, same as any other local-dev tool. Set `FINANFA_WEB_USERS` to require a token and isolate each user's own sessions from everyone else's:

```bash
export FINANFA_WEB_USERS="alice:some-long-random-token,bob:another-long-random-token"
npm run dev:web-server
```

Every `/api/*` request then needs `Authorization: Bearer <token>` (inbound channel webhooks are unaffected — they have their own signature verification instead); the WebSocket connection needs a `?token=` query param. A session created under one user's token is invisible to (and can't be resumed or deleted by) another user's — `GET /api/sessions` only lists your own, `DELETE /api/sessions/:id` 403s on someone else's, and resuming someone else's session over WebSocket closes the connection instead. A session with no owner recorded (predates this feature, or was created by the CLI/VS Code/ACP, which have no such concept) is unclaimed — the first user to resume it adopts it.

**Real accounts instead of (or alongside) shared static tokens**: set `FINANFA_WEB_ACCOUNTS=1` to enable real, per-login accounts with hashed passwords (scrypt, random salt per password — never the plain password — persisted to `~/.finanfa-code/web-users.json`), independent of `FINANFA_WEB_USERS` (either can be used alone, or both together):

```bash
export FINANFA_WEB_ACCOUNTS=1
npm run dev:web-server
# first account ever needs no auth to create (bootstrap) — every one after that does:
curl -X POST http://localhost:4600/api/auth/users -H 'content-type: application/json' -d '{"username":"alice","password":"a-real-password"}'
curl -X POST http://localhost:4600/api/auth/login -H 'content-type: application/json' -d '{"username":"alice","password":"a-real-password"}'
# -> {"token": "...", "user": "alice"} — use that token exactly like a static FINANFA_WEB_USERS one
```

A login's session token (30-day expiry, persisted to `~/.finanfa-code/web-sessions.json` — a server restart no longer forces logging in again) authenticates identically to a static token everywhere else in this section. Once logged in, alice can create further accounts (`POST /api/auth/users` with her own token) without needing a shared secret handed to her out of band.

**SSO — log in with Google/Okta/any real OIDC provider**: set `FINANFA_WEB_OIDC_ISSUER`/`FINANFA_WEB_OIDC_CLIENT_ID`/`FINANFA_WEB_OIDC_CLIENT_SECRET`/`FINANFA_WEB_OIDC_REDIRECT_URI` (register the redirect URI as `https://<your-server>/api/auth/oidc/callback` with your provider). A real Authorization Code + PKCE flow: visiting `GET /api/auth/oidc/login` redirects to the provider; after login it redirects back to `/#token=...&user=...` (a URL fragment — never sent to the server, so it can't leak via logs/Referer) with a real session token that authenticates identically to a password login's. Trusts the provider's userinfo endpoint for identity rather than verifying the ID token's JWT signature locally — a real, honest simplification (an attacker without a genuinely valid access token can't get a userinfo response back either way), not a silent gap.

This covers real authentication and per-user session isolation within one web-server process — not a separate control-plane service coordinating multiple downstream agent instances, and not per-user isolation of the underlying project/workspace files themselves (every authenticated user shares the same projects on disk; only conversation history is private).

### Docker

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build
```

Serves the same web app on `http://localhost:4600`. `./workspace` on the host is the agent's project directory inside the container; `~/.finanfa-code` config/sessions persist in a named volume across restarts. Set `FINANFA_PROVIDER`/`FINANFA_BASE_URL`/`FINANFA_MODEL`/`FINANFA_API_KEY` instead of `ANTHROPIC_API_KEY` for an OpenAI-compatible backend.

### Fly.io / Render.com (self-hosting on someone else's hardware)

Both build the same [Dockerfile](Dockerfile) above — nothing extra to write, just a hosting target for it:

- **[fly.toml](fly.toml)**: `fly launch --no-deploy` (creates/renames the app), `fly volumes create finanfa_data --size 1 --region <region>` (persists `~/.finanfa-code` across deploys), `fly secrets set ANTHROPIC_API_KEY=...`, `fly deploy`.
- **[render.yaml](render.yaml)**: in the Render dashboard, "New +" → "Blueprint", point it at this repo — Render reads the file and creates the service; set `ANTHROPIC_API_KEY` as a real secret in the service's Environment tab afterward (deliberately not committed to the file).

Either way, the project directory itself (`/workspace` inside the container) is NOT persisted by default — only `~/.finanfa-code` (sessions/config/memory) is. Mount a second volume/disk at `/workspace` if you want the actual checkout to survive a restart too, instead of starting fresh from whatever the image's `COPY . .` baked in.

## CLI flags

| Flag | Effect |
|---|---|
| `-r, --resume <id>` / `-c, --continue` | Resume a saved session |
| `-m, --model <model>` | Model to use |
| `--yolo` | Auto-approve every tool call (no prompts) |
| `--non-interactive` | Never prompt; auto-deny anything not pre-allowed |
| `--ui <ink\|readline>` | Terminal UI mode |
| `-p, --prompt <text>` | Run one prompt non-interactively and exit — no REPL. Scripts/cron, or a one-shot "build me X" from a shell (its `--cwd` is created if it doesn't exist yet) |
| `--cwd <path>` | Project directory to operate in (defaults to the current directory) |
| `--max-turns <n>` | With `--prompt`: if a turn is cut off by the step-limit guard (a large task, not a stuck loop), automatically send "continue" up to this many additional times before giving up. Default `5`; `1` disables auto-continue |
| `--acp` | Run as an [Agent Client Protocol](https://agentclientprotocol.com/) agent over stdio, for an ACP-aware editor (e.g. Zed) to drive directly — see [Editor integration (ACP)](#editor-integration-acp) |

Non-interactive one-shot example — builds a whole app in one command, auto-continuing past the per-turn step limit as needed:

```bash
npm run dev -- --yolo --cwd ./my-new-app -p "Build me a complete Flutter e-commerce app with simulated payments"
```

## Commands

Type `/` for live autocomplete.

| Command | Effect |
|---|---|
| `/help` | List all commands |
| `/cost` | Token usage and cost for the session |
| `/clear` | Clear conversation history |
| `/compact` | Summarize the conversation into a condensed note |
| `/undo` | Revert the most recent file write/edit |
| `/rewind [n]` | Restore conversation + files to a past checkpoint (no arg: list checkpoints) |
| `/plan [on\|off]` | Plan mode — while on, only read-only tools run until a plan is proposed and approved |
| `/tools [list]` / `/tools enable\|disable <name>` | List/toggle registered tools |
| `/todos` | Show the current task checklist |
| `/memory` | List saved project memory notes |
| `/goal [text]` | Set/clear a standing session goal |
| `/sessions` / `/session <id>` | List / switch sessions |
| `/mcp ...` | Manage MCP servers — see below |
| `/config ...` | Persistent provider defaults — see above |
| `/exit` | Quit |

Ctrl+C persists the session and closes connections cleanly before exit.

## Project-local configuration (`.finanfa-code/`)

- `settings.json` — permission rules (`{ "rules": [{ "tool": "bash", "keyPrefix": "git", "cwdPrefix": "packages/web-client", "decision": "allow" }], "defaultForRiskLevel": {...} }` — `tool: "*"` matches every tool, `keyPrefix`/`cwdPrefix` are each optional and both must match when both are given; `cwdPrefix` scopes a rule to part of a monorepo, e.g. auto-allowing `bash` inside one already-reviewed directory without loosening it everywhere else), plus an optional `hooks` field (`PreToolUse`/`PostToolUse`/`UserPromptSubmit` shell hooks, same convention as Claude Code). A project is untrusted by default the first time you open it — you're asked once whether to trust its `settings.json`; declining ignores its rules/hooks for that run.
- `commands/*.md` — custom `/name` slash commands (frontmatter `name`/`description` + a prompt-template body; `$ARGUMENTS` is replaced with the args).
- `agents/*.md` — named subagent types for the `task` tool (its own system prompt, optionally a restricted `tools` whitelist), selected via `task`'s `agentType` input.
- `skills/*.md` — frontmatter + body, loaded on demand via `read_skill`.
- `memory/*.md` — durable notes the agent writes itself via `write_memory` (preferences, decisions, project context).
- `mcp.json` — `{ "servers": [...] }`, one entry per MCP server (stdio or http/sse).
- `plugins/<name>/index.js` — exports `registerTools`/`registerCommands`. See [docs/plugins.md](docs/plugins.md) for the full contract.
- `finanfa.md` (project root) — free-form project instructions, folded into the system prompt (the `CLAUDE.md`/`AGENTS.md` equivalent).
- `instructions/*.md` — path-scoped project instructions, for conventions that only apply to one part of a monorepo (frontend vs. backend, tests vs. everything else) instead of competing for attention in one `finanfa.md`. Frontmatter `description` (optional) and `applyTo` (a glob, or a list of globs — omit it for a note that's always relevant regardless of path). Every one of these is included in the system prompt up front, labeled with its own globs — unlike an IDE that only shows instructions for the file you have open, this project has no "currently open file" to key off, so the model is expected to apply each one only when it's actually working on a matching path:
  ```markdown
  ---
  description: React conventions
  applyTo: "packages/web-client/**/*.tsx"
  ---

  Function components only, never class components. Co-locate a component's styles in the same file.
  ```
- `finanfa-design.md` (project root) — design contract for `create_artifact`, replaces the built-in default when present.

Skills, memory, commands, and agents each have a global counterpart under `~/.finanfa-code/` (merged with the project-local ones; project wins on a name collision).

### Bundles ("Claws")

`export_bundle`/`install_bundle`/`list_bundle_snapshots`/`rollback_bundle` package everything above (permission rules/hooks, MCP servers, memory, skills, commands, agent types, path-scoped instructions, `finanfa.md`/`finanfa-design.md`) into one shareable, versioned JSON bundle — a checkpoint of a project's whole configuration, or a way to hand someone else an identical setup. `install_bundle` snapshots the exact prior content of every file it's about to overwrite first, so `rollback_bundle` can undo it exactly (deleting a file that didn't exist before, restoring one that did). **A bundle's `settings.json` can carry hooks — arbitrary shell commands that run automatically once the project is trusted** — so `install_bundle` is `riskLevel: "dangerous"`; only install one from a source you actually trust.

Every bundle is cryptographically signed (Ed25519, `~/.finanfa-code/claws-identity.json` — a stable identity generated automatically the first time you export one) — `install_bundle` verifies the signature (catching a bundle tampered with or corrupted in transit) and reports whether this machine has seen that publisher's key before (`~/.finanfa-code/claws-trusted-publishers.json`), plus whether this is a new/upgrade/downgrade/reinstall relative to whatever version of that bundle name was last installed into this project (`.finanfa-code/.claws/installed.json`). A valid signature only proves the content wasn't altered after signing — it says nothing about whether that content is safe to install.

Beyond sharing the JSON directly (a gist, a file attachment), `publish_bundle_to_registry`/`list_registry_bundles`/`list_registry_bundle_versions`/`install_bundle_from_registry` publish to and install from a real hosted registry — any GitHub repository the user (or their org) already controls (public for open sharing, private for an internal one), using GitHub's own real Contents API as the storage backend (`bundles/<name>/<version>.json`, committed like any other file). Published versions are immutable — bump the bundle's version to publish an update. Requires `CLAWS_REGISTRY_TOKEN` (a GitHub personal access token) to publish; listing/installing from a public repo works without one.

### MCP (connecting external services)

```
/mcp add github -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server
/mcp add myservice --url https://mcp.example.com/mcp
```

Stdio servers run as a local process; `http`/`sse` servers go through an OAuth flow on first use if required (`/mcp connect <name>`), with tokens persisted under `~/.finanfa-code/mcp-auth/`. Any server implementing the MCP spec works this way — GitHub, Notion, Gmail, Google Drive, Canva, Supabase, and others have official or community servers.

The web UI's one-click connector catalog (`packages/web-server/src/mcp-catalog.ts`) also ships Hostinger's own `hostinger-api-mcp` package as five separate stdio servers — hosting, domains, DNS, billing, and reach (each its own real npx-launched process, confirmed connecting end to end: 73/41/8/9/52 real tools respectively), alongside GitHub/Notion/Canva/Supabase/Gamma/Vercel.

With a GitHub MCP server connected, the agent can carry an issue through to a PR end to end (read issue → branch → change → test → commit → push → open PR).

### Vision routing

Not every model can see images. If your primary model can't, route just the turn right after a screenshot/`view_image` call to a vision-capable model instead:

```
/config set visionProvider anthropic
/config set visionModel claude-sonnet-5
/config set visionApiKey <your key>
```

(or `visionProvider openai-compatible` + `visionBaseUrl`/`visionModel`/`visionApiKey`). Every other turn still uses the primary model.

## Tools

90+ builtin tools, each gated by a risk level (`safe`/`ask`/`dangerous`) enforced through the permission system. Highlights by category:

- **Files & code**: `read_file`, `write_file`, `edit_file`, `multi_edit_file`, `glob`, `grep`
- **Shell & processes**: `bash`, `run_tests`, `start_background_process`/`list_background_processes`/`stop_background_process`, `wait_for_port`
- **Git**: `git_status`/`git_diff`/`git_log`/`git_branch`/`git_fetch` (safe), `git_add`/`git_commit`/`git_checkout`/`git_push`/`git_pull`/`git_stash` (ask)
- **Web & browser**: `web_search`, `web_fetch`, `http_request`, `browser_navigate`/`browser_click`/`browser_screenshot` (Playwright/Chromium), `preview_html`
- **Documents**: `read_document`/`write_document`/`edit_document` (PDF, Word, Excel, CSV), `write_spreadsheet`/`edit_spreadsheet`/`merge_spreadsheets`, `merge_pdf`/`split_pdf`/`images_to_pdf`/`convert_pdf_to_image`, `convert_to_pdf`, `convert_spreadsheet`, `ocr_image`, `read_notebook`/`edit_notebook`
- **Images**: `view_image`, `resize_image`, `generate_2d` (real image generation via OpenAI's Images API, needs `OPENAI_API_KEY`), `generate_3d` (currently disabled — see below)
- **Video/music generation**: `generate_video`/`generate_music` (needs `REPLICATE_API_TOKEN`) — real, billed generation via any Replicate model (e.g. `"minimax/video-01"` for video, `"meta/musicgen"` for music), passing that model's own real input fields straight through rather than a fixed schema (every Replicate model's input is different — check the model's own page on replicate.com). Neither OpenAI nor Gemini has a broadly-available, non-invite-only API for this; Replicate hosts real open models for both behind one ordinary API token.
- **Video**: `view_video_frames` (when `ffmpeg`/`ffprobe` are installed) — samples a handful of evenly-spaced still frames from a video file for the model to look at (not full video understanding: no motion/timing/audio); `analyze_video` (real native video+audio understanding via Gemini, needs `GEMINI_API_KEY`, independent of the primary chat provider). A video under ~19MB is sent in one request; a larger one (up to 200MB) goes through Gemini's real File API instead — the actual documented resumable-upload protocol (upload, wait for real server-side processing, analyze, then delete it). Confirmed end to end against a real Gemini account (both the inline and File API paths, including a real ~21MB video), with retry now covering the upload steps too — a transient network blip during a real multi-minute upload no longer fails the whole thing outright.
- **Voice & messaging**: `text_to_speech` (free, Google Translate backend), `transcribe_audio` (Whisper, needs `OPENAI_API_KEY`), `send_slack_message`/`send_telegram_message`/`send_matrix_message`/`send_line_message`/`send_feishu_message`/`send_teams_message`/`send_discord_message`/`send_whatsapp_message`/`send_sms_message`, `send_email` — see [Channels](#channels) for the inbound side of Slack/Telegram/Matrix/LINE/Feishu/Teams/Discord/WhatsApp/SMS
- **Productivity**: `read_notion_page`/`write_notion_page` (real Notion API, needs `NOTION_API_KEY`), `create_trello_card` (real Trello API, needs `TRELLO_API_KEY`/`TRELLO_API_TOKEN`), `get_spotify_now_playing`/`control_spotify_playback` (real Spotify Web API, needs `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`/`SPOTIFY_REFRESH_TOKEN`)
- **Smart home**: `get_smart_home_state`/`control_smart_home_device` (real Home Assistant REST API, needs `HOME_ASSISTANT_BASE_URL`/`HOME_ASSISTANT_TOKEN`) — Home Assistant's own REST API covers thousands of real device integrations behind one interface
- **Code quality**: `check_python_types` (Pyright), `check_typescript_types` (tsc), `lint_javascript` (ESLint), `lint_python` (ruff)
- **Data**: `query_database` (SQLite/Postgres/MySQL), `python_repl` (persistent interpreter)
- **UI generation**: `create_artifact` (React + Tailwind, live preview)
- **Delegation**: `task` (sub-agents, optionally a named `agentType`), `todo_write` (shown live in the web UI as a real Kanban-style board — see the sidebar's Tasks panel — not just a plain-text checklist)
- **IoT/embedded**: `serial_*`, `run_esptool`/`run_avrdude`, `mqtt_publish`/`mqtt_subscribe`, `coap_request`, `gpio_*`, `run_arduino_cli`/`run_platformio`
- **DevOps**: `run_docker`, `run_kubectl`, `run_mydevops` (when installed)
- **Fleet** (when `docker` is installed): `create_fleet_cell`/`list_fleet_cells`/`stop_fleet_cell`/`remove_fleet_cell`/`create_fleet_network`/`remove_fleet_network` — provisions/manages isolated per-tenant containers ("cells"), each its own real Docker container with its own port and optional persistent workspace mount. Every cell is named with a fixed prefix so these tools can only ever affect containers they created themselves, never an unrelated one on the same Docker daemon. Supports real Docker resource limits (`--memory`/`--cpus`), a restart policy, a health check (reported back as healthy/unhealthy in `list_fleet_cells`), a shared network so cells can reach each other by name, and placing a cell on a **remote** machine via a real `DOCKER_HOST` value (e.g. `ssh://user@remote-machine`, over the user's own already-configured SSH). `register_fleet_host`/`list_fleet_hosts`/`remove_fleet_host` maintain a persistent pool of hosts (`~/.finanfa-code/fleet-hosts.json`); when `create_fleet_cell` is called without an explicit `host`, it auto-schedules onto whichever registered, reachable host currently has the fewest running cells (a real, live `docker ps`/`docker version` check per host at schedule time) — live-load placement, not bin-packing by CPU/memory telemetry, live migration, or a persistent scheduling daemon.
- **Remote execution / node-host** (when `ssh` is installed): `run_remote_command` — runs a command on a separate machine over the user's own already-configured SSH (host aliases/keys/agent from their real `~/.ssh/config`), `riskLevel: "dangerous"`, permission scoped per host. Optional `retries` (default 0, off) retries a transient CONNECTION failure with backoff — a network blip, host briefly unreachable — but never once the remote command itself actually ran and returned its own exit code (ssh's own exit 255 is the real, documented signal used to tell those apart, the same one tools like Ansible rely on), so only set it above 0 for a command that's safe to run more than once. `register_remote_host`/`list_remote_hosts`/`remove_remote_host`/`check_remote_host_health` — a persistent, named registry of remote machines (`~/.finanfa-code/remote-hosts.json`) with a real, live health probe (uptime + disk usage over SSH, automatically retried a couple of times on a transient connection failure before actually reporting unhealthy — safe to retry since it's read-only), so "which of my remote nodes are actually up right now?" doesn't mean re-typing host/user/port for each one.
- **macOS UI automation**: `run_applescript` (macOS only) — drives other applications (Finder, Mail, Music, System Events for cross-app UI scripting) via a real AppleScript, the same mechanism a native macOS automation script would use
- **Agent delegation**: `delegate_to_claude_code`/`delegate_to_codex` (when the `claude`/`codex` CLI is installed) — hands a task to a completely separate coding-agent CLI (its own model/tools/context), a generic argv passthrough rather than a fixed prompt-only shape, `riskLevel: "dangerous"`
- **Secrets**: `read_1password_secret` (via the `op` CLI), `read_vault_secret` (via the `vault` CLI) — both only registered when the underlying CLI is installed, `riskLevel: "dangerous"`
- **Security scanning**: prompt injection/jailbreak/system-prompt-leak/PII-leakage/excessive-agency self-red-team, plus SSRF/XSS/SQLi/XXE/SSTI/IDOR/CSRF/JWT/LDAP-injection/subdomain-takeover/recon/email-security/and more against a target URL
- **Session**: `recall_past_sessions` (full-text search over past sessions, plus an optional semantic mode — needs `OPENAI_API_KEY`), `write_memory`/`delete_memory`, `find_duplicate_memories` (a tool-driven stand-in for background memory consolidation — reports likely near-duplicate notes to merge, doesn't merge them itself), `search_memories` (find a saved note by meaning, not just its exact name — keyword mode by default, or an optional semantic mode over embeddings, same `OPENAI_API_KEY`-gated cosine-similarity search as `recall_past_sessions`, cached by content hash so an unchanged note never costs a repeat API call). Every note also carries real provenance: when it was first saved, when it was last updated, and which session actually originated it.
- **Observability**: `read_traces` (OpenTelemetry tool-call/LLM-turn durations and error rates), `read_audit_log` (structured permission-decision audit trail — see [Security](#security))

Notes:
- `web_search`/`web_fetch`/`browser_*` results are wrapped as untrusted content — treated as data, not instructions, to reduce prompt-injection risk.
- `read_file`/`write_file`/`edit_file` work within the project root or the user's home directory; nothing outside either is reachable through these tools (not a hard security boundary — `bash` has none).
- `generate_2d` generates a real image via OpenAI's Images API (`gpt-image-1`) when `OPENAI_API_KEY` is set — a real, metered call, not free, unlike the rest of this project's image tools. Without it, reports unavailable rather than silently failing (NVIDIA NIM lists free FLUX/Stable Diffusion models on the same free catalog this project's text/vision routing already uses, but its image endpoint never responded across three real test attempts). `generate_3d` is still an honest stub: no image-to-3D provider is wired in (SAM 3D/TRELLIS need 24-32GB of VRAM to self-host; no paid API like fal.ai is configured).

## Channels

Besides the terminal, browser, and VS Code UIs, the web server can be reached from outside as a chat bot — an inbound message runs one real agent turn (same tools/permissions as everywhere else) and gets a reply posted back.

### Slack

```bash
export SLACK_SIGNING_SECRET=...   # from your Slack app's "Basic Information" page
export SLACK_BOT_TOKEN=xoxb-...   # from "OAuth & Permissions", needs the chat:write scope
npm run dev:web-server
```

Then, in your Slack app's settings:
1. **Event Subscriptions** → enable, Request URL = `https://<your-server>/api/channels/slack/events` (Slack verifies this URL itself via the same handshake the endpoint answers).
2. Subscribe to the `message.channels` and/or `app_mention` bot events.
3. Invite the bot to a channel and message it (or @-mention it) — each thread maps to its own persistent session, so the agent keeps context across replies in that thread.

The endpoint 404s until `SLACK_SIGNING_SECRET` is set — there's no unauthenticated middle state. Every inbound message currently runs against the server's own default workspace (`FINANFA_WEB_CWD`/cwd), not a per-channel project.

### Telegram

```bash
export TELEGRAM_BOT_TOKEN=123456:...       # from @BotFather
export TELEGRAM_WEBHOOK_SECRET=...         # any string you pick
npm run dev:web-server
```

Then register the webhook once (replace the two placeholders):

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-server>/api/channels/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Message the bot directly, or in a group it's been added to — each chat (or forum topic, in a topics-enabled supergroup) maps to its own persistent session. Same 404-until-configured behavior as Slack above.

### Matrix

Runs as a real [Application Service](https://spec.matrix.org/latest/application-service-api/) — works against any homeserver (Synapse, Dendrite, Conduit, self-hosted or not), since Matrix is a federated, open protocol, not a single vendor's API:

```bash
export MATRIX_HOMESERVER_URL=https://matrix.example.org   # your homeserver's own base URL
export MATRIX_AS_TOKEN=...           # this AS's own token, set when you register it — authenticates its outbound API calls
export MATRIX_HS_TOKEN=...           # a separate token the HOMESERVER authenticates its pushes to us with
export MATRIX_BOT_USER_ID=@finanfa-bot:example.org   # this AS's own bot user id, so it can recognize (and ignore) its own sent messages
npm run dev:web-server
```

Then register the Application Service on your homeserver (a YAML file, e.g. Synapse's `app_service_config_files`):

```yaml
id: finanfa-code
url: https://<your-server>/api/channels/matrix/transactions
as_token: "<MATRIX_AS_TOKEN>"
hs_token: "<MATRIX_HS_TOKEN>"
sender_localpart: finanfa-bot
namespaces:
  users: [{ exclusive: true, regex: "@finanfa-bot:example\\.org" }]
  rooms: []
  aliases: []
```

Invite the bot's user id to a room (or have it join one) — each room maps to its own persistent session. Same 404-until-configured, real-token-verified behavior as every other channel here; the homeserver's own push is acked immediately (a real turn takes far longer than Matrix's own transaction-delivery timeout), same reasoning as Telegram/Slack above.

### LINE

```bash
export LINE_CHANNEL_SECRET=...         # from the LINE Developers Console → your channel's Basic settings
export LINE_CHANNEL_ACCESS_TOKEN=...   # same console, Messaging API tab — issue a long-lived channel access token
npm run dev:web-server
```

Then, in the LINE Developers Console's Messaging API tab, set the **Webhook URL** to `https://<your-server>/api/channels/line/webhook` and enable "Use webhook" (LINE verifies reachability itself via a "Verify" button, not an automatic handshake).

Message the bot directly, or in a group/room it's been added to — each user/group/room maps to its own persistent session. Replies go through the Messaging API's push endpoint rather than its one-time, short-lived reply token, since a real agent turn routinely takes longer than a reply token stays valid. Same 404-until-configured, real-signature-verified behavior as every other channel here.

### Feishu / Lark

```bash
export FEISHU_VERIFICATION_TOKEN=...   # from your app's Event Subscriptions page
export FEISHU_APP_ID=cli_...           # from the app's Credentials & Basic Info page
export FEISHU_APP_SECRET=...           # same page
npm run dev:web-server
```

Then, on your app's Event Subscriptions page, set the **Request URL** to `https://<your-server>/api/channels/feishu/webhook` (Feishu verifies this itself via a one-time `url_verification` handshake the endpoint answers) and subscribe to the `im.message.receive_v1` event.

Message the bot directly, or in a group it's been added to — each chat maps to its own persistent session. Outbound replies authenticate with a real `tenant_access_token` (fetched via `FEISHU_APP_ID`/`FEISHU_APP_SECRET` and cached until shortly before its real ~2-hour expiry), not a static bot token. Verification is Feishu's Verification-Token scheme (a shared secret embedded in the event body itself); the optional "Encrypt Key" mode that AES-encrypts the whole event payload isn't implemented — a real, disclosed scope boundary, not a silent gap.

### Microsoft Teams

Runs as a real [Bot Framework](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication) bot, registered as an Azure Bot resource:

```bash
export MICROSOFT_APP_ID=...          # the bot's Microsoft App ID (single- or multi-tenant), from its Azure Bot resource
export MICROSOFT_APP_PASSWORD=...    # a client secret for that same app registration
npm run dev:web-server
```

Then, on the Azure Bot resource's **Configuration** page, set the **Messaging endpoint** to `https://<your-server>/api/channels/teams/webhook`, and enable the Teams channel.

Message the bot directly, or @-mention it in a channel it's been added to — each conversation maps to its own persistent session. Unlike every other channel here, Teams has no fixed API host or simple bot token: inbound requests carry a real JWT signed by Microsoft, verified with a real RS256 signature check against Microsoft's own published, rotating keys (fetched via the real OpenID Connect discovery + JWKS endpoints, cached) — genuinely more machinery than this project's own OIDC login flow uses, since there's no "ask the platform itself" shortcut available for a webhook push the way a login flow's userinfo endpoint gives one. Outbound replies authenticate with a real OAuth2 `client_credentials` token (cached until shortly before its real expiry) and post to whichever `serviceUrl`/conversation id the inbound activity itself specified — both differ per region/tenant, unlike a fixed API base URL.

### Discord

Discord's webhook model only delivers interactions (slash commands), not plain channel messages, so this registers one command, `/ask`:

```bash
export DISCORD_PUBLIC_KEY=...        # your app's "Public Key", from the Discord Developer Portal
export DISCORD_APPLICATION_ID=...    # same page
export DISCORD_BOT_TOKEN=...         # only needed for the send_discord_message tool, not the channel itself
npm run dev:web-server
```

Then, one-time setup in the Discord Developer Portal:
1. **General Information** → set **Interactions Endpoint URL** to `https://<your-server>/api/channels/discord/interactions` (Discord verifies this itself via a signed PING, same handshake the endpoint answers — it won't save the URL otherwise).
2. Register the `/ask` command once:
   ```bash
   curl -X PUT "https://discord.com/api/v10/applications/<DISCORD_APPLICATION_ID>/commands" \
     -H "Authorization: Bot <DISCORD_BOT_TOKEN>" -H "content-type: application/json" \
     -d '[{"name":"ask","description":"Ask the agent something","options":[{"name":"message","description":"Your message","type":3,"required":true},{"name":"image","description":"An image to include","type":11,"required":false}]}]'
   ```
3. Invite the bot to a server and run `/ask message:<your question>` in any channel — each channel maps to its own persistent session. Discord shows "thinking..." immediately (a turn takes longer than its 3-second reply window), then edits in the real answer once it's ready. Attaching an image via the optional `image` option routes the turn through the project's configured vision model, same as a Slack file upload or the CLI/web UI's own image input.

### WhatsApp

Uses the [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) (a Meta developer app + a WhatsApp Business phone number, not a personal WhatsApp account):

```bash
export WHATSAPP_APP_SECRET=...          # your Meta app's "App Secret", from App Settings → Basic
export WHATSAPP_VERIFY_TOKEN=...        # any string you pick — used only for the one-time handshake below
export WHATSAPP_ACCESS_TOKEN=...        # a token for the WhatsApp Business Account, from WhatsApp → API Setup
export WHATSAPP_PHONE_NUMBER_ID=...     # same page — the sending number's id, not the phone number itself
npm run dev:web-server
```

Then, in your Meta app's WhatsApp → Configuration page:
1. Set **Callback URL** to `https://<your-server>/api/channels/whatsapp/webhook` and **Verify Token** to the same value as `WHATSAPP_VERIFY_TOKEN` — Meta verifies this itself via a signed `GET` handshake (`hub.mode`/`hub.verify_token`/`hub.challenge`) before it'll save the URL.
2. Subscribe the app to the `messages` webhook field.
3. Message the connected number — each sender's phone number maps to its own persistent session.

The endpoint 404s (both the GET handshake and POST events) until its own env vars are set — same "no unauthenticated middle state" as every other channel here. Only plain text messages are handled today; media/location/interactive-reply messages are ignored.

### SMS

Uses [Twilio](https://www.twilio.com/docs/usage/security#validating-requests)'s Programmable Messaging API:

```bash
export TWILIO_ACCOUNT_SID=AC...      # from the Twilio Console dashboard
export TWILIO_AUTH_TOKEN=...         # same page — also what verifies inbound webhook requests
export TWILIO_FROM_NUMBER=+1...      # your Twilio phone number, E.164 format
npm run dev:web-server
```

Then, on that number's **Configure** page in the Twilio Console, set **"A message comes in"** to `https://<your-server>/api/channels/sms/webhook` (HTTP POST). Twilio signs every webhook request against the exact URL it's configured to call, so this only verifies correctly once the server is actually reachable at that same public URL — same requirement `TWILIO_WEBHOOK_URL` lets you override explicitly if the server sits behind something that changes what it sees as its own host/protocol.

Each sender's phone number maps to its own persistent session. Same 404-until-configured behavior as every other channel here.

### Voice

Uses the same Twilio account/`TWILIO_AUTH_TOKEN` as SMS above — Programmable Voice, not Messaging:

```bash
export TWILIO_AUTH_TOKEN=...
npm run dev:web-server
```

On that number's **Configure** page, set **"A call comes in"** to `https://<your-server>/api/channels/voice/webhook` (HTTP POST). Twilio Voice's webhook is fundamentally synchronous — the caller is on hold waiting for this exact HTTP response, unlike every text-based channel here, which acks immediately and replies later via its own send API. A full tool-calling turn routinely takes longer than a caller will wait (or than Twilio's own webhook timeout allows), so a turn is raced against an 8s deadline: within it, the caller hears the real reply and the conversation continues (`<Gather input="speech">` loops back for a follow-up); past it, the caller is told honestly instead of sitting on hold, and — if `TWILIO_ACCOUNT_SID`/`TWILIO_FROM_NUMBER` (see SMS above) are also configured — texted the answer once the turn actually finishes. Each call gets its own session (keyed by Twilio's own CallSid), unlike SMS/WhatsApp's persistent per-sender thread — a phone call is one bounded conversation, not an ongoing one.

## Editor integration (ACP)

`finanfa --acp` runs as an [Agent Client Protocol](https://agentclientprotocol.com/) agent over stdio — the same tools/permissions/hooks as every other entry point, driven directly from an ACP-aware editor instead of a terminal or browser.

### Zed

Add a custom agent server in Zed's settings (`~/.config/zed/settings.json`, or via the Settings UI):

```json
{
  "agent_servers": {
    "finanfa-code": {
      "type": "custom",
      "command": "finanfa",
      "args": ["--acp"]
    }
  }
}
```

Open Zed's Agent panel and select "finanfa-code" to start a thread. Each Zed thread gets its own session; the working directory Zed reports for that thread is used as-is.

Scope of this first pass: the core lifecycle (init, session, prompt streaming, tool calls, permission requests, cancel) is real and tested — richer ACP surfaces (session modes, per-session MCP servers, `loadSession` replay, client filesystem/terminal methods) aren't implemented yet.

## Security

The system prompt permits authorized security testing, defensive security, CTF, and security education, and declines destructive techniques, DoS tooling, mass targeting, supply-chain compromise, or detection evasion — several supported backends (local/free models) have little built-in safety alignment of their own.

Every permission decision (allow/deny, and which of a PreToolUse hook/`--yolo`/the session allowlist/a config rule/the risk-level default/a direct user answer decided it) is appended to a structured audit trail at `~/.finanfa-code/audit/<date>.jsonl` — one JSON line per decision, independent of both the OpenTelemetry trace file (`~/.finanfa-code/traces/`, perf-only, never sees a denied call) and the session transcript. Read it back with the `read_audit_log` tool, or directly with `jq`/`grep` for a compliance review.

## Tests

```bash
npm run typecheck
npm test
```

Real end-to-end coverage throughout: fixture MCP servers (stdio + Streamable HTTP), real Chromium automation (`npx playwright-core install chromium` first), real subprocess/network tests for the IoT and DevOps tool wrappers, and a real WebSocket/subprocess harness for the web server.
