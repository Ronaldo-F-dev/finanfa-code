# finanfa-code

A from-scratch AI coding agent, in TypeScript, with a terminal UI (Ink) and a browser UI. Pluggable LLM backend: Anthropic, Azure OpenAI, Gemini, Amazon Bedrock, Google Vertex AI, or anything speaking the OpenAI chat-completions wire format (Ollama, OpenRouter, Poolside, LM Studio, vLLM, ...).

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

### Docker

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build
```

Serves the same web app on `http://localhost:4600`. `./workspace` on the host is the agent's project directory inside the container; `~/.finanfa-code` config/sessions persist in a named volume across restarts. Set `FINANFA_PROVIDER`/`FINANFA_BASE_URL`/`FINANFA_MODEL`/`FINANFA_API_KEY` instead of `ANTHROPIC_API_KEY` for an OpenAI-compatible backend.

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

- `settings.json` — permission rules, plus an optional `hooks` field (`PreToolUse`/`PostToolUse`/`UserPromptSubmit` shell hooks, same convention as Claude Code). A project is untrusted by default the first time you open it — you're asked once whether to trust its `settings.json`; declining ignores its rules/hooks for that run.
- `commands/*.md` — custom `/name` slash commands (frontmatter `name`/`description` + a prompt-template body; `$ARGUMENTS` is replaced with the args).
- `agents/*.md` — named subagent types for the `task` tool (its own system prompt, optionally a restricted `tools` whitelist), selected via `task`'s `agentType` input.
- `skills/*.md` — frontmatter + body, loaded on demand via `read_skill`.
- `memory/*.md` — durable notes the agent writes itself via `write_memory` (preferences, decisions, project context).
- `mcp.json` — `{ "servers": [...] }`, one entry per MCP server (stdio or http/sse).
- `plugins/<name>/index.js` — exports `registerTools`/`registerCommands`. See [docs/plugins.md](docs/plugins.md) for the full contract.
- `finanfa.md` (project root) — free-form project instructions, folded into the system prompt (the `CLAUDE.md`/`AGENTS.md` equivalent).
- `finanfa-design.md` (project root) — design contract for `create_artifact`, replaces the built-in default when present.

Skills, memory, commands, and agents each have a global counterpart under `~/.finanfa-code/` (merged with the project-local ones; project wins on a name collision).

### MCP (connecting external services)

```
/mcp add github -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server
/mcp add myservice --url https://mcp.example.com/mcp
```

Stdio servers run as a local process; `http`/`sse` servers go through an OAuth flow on first use if required (`/mcp connect <name>`), with tokens persisted under `~/.finanfa-code/mcp-auth/`. Any server implementing the MCP spec works this way — GitHub, Notion, Gmail, Google Drive, Canva, Supabase, and others have official or community servers.

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
- **Images**: `view_image`, `resize_image`, `generate_2d`/`generate_3d` (currently disabled — see Status)
- **Voice & messaging**: `text_to_speech` (free, Google Translate backend), `transcribe_audio` (Whisper, needs `OPENAI_API_KEY`), `send_slack_message`/`send_telegram_message`/`send_discord_message`, `send_email` — see [Channels](#channels) for the inbound side of Slack/Telegram/Discord
- **Code quality**: `check_python_types` (Pyright), `check_typescript_types` (tsc), `lint_javascript` (ESLint), `lint_python` (ruff)
- **Data**: `query_database` (SQLite/Postgres/MySQL), `python_repl` (persistent interpreter)
- **UI generation**: `create_artifact` (React + Tailwind, live preview)
- **Delegation**: `task` (sub-agents, optionally a named `agentType`), `todo_write`
- **IoT/embedded**: `serial_*`, `run_esptool`/`run_avrdude`, `mqtt_publish`/`mqtt_subscribe`, `coap_request`, `gpio_*`, `run_arduino_cli`/`run_platformio`
- **DevOps**: `run_docker`, `run_kubectl`, `run_mydevops` (when installed)
- **Security scanning**: prompt injection/jailbreak/system-prompt-leak/PII-leakage/excessive-agency self-red-team, plus SSRF/XSS/SQLi/XXE/SSTI/IDOR/CSRF/JWT/LDAP-injection/subdomain-takeover/recon/email-security/and more against a target URL
- **Session**: `recall_past_sessions` (full-text search over past sessions, plus an optional semantic mode — needs `OPENAI_API_KEY`), `write_memory`

Notes:
- `web_search`/`web_fetch`/`browser_*` results are wrapped as untrusted content — treated as data, not instructions, to reduce prompt-injection risk.
- `read_file`/`write_file`/`edit_file` work within the project root or the user's home directory; nothing outside either is reachable through these tools (not a hard security boundary — `bash` has none).
- `generate_2d`/`generate_3d` are honest stubs: no free image/3D-generation backend currently works reliably, so they report that instead of silently failing.

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
     -d '[{"name":"ask","description":"Ask the agent something","options":[{"name":"message","description":"Your message","type":3,"required":true}]}]'
   ```
3. Invite the bot to a server and run `/ask message:<your question>` in any channel — each channel maps to its own persistent session. Discord shows "thinking..." immediately (a turn takes longer than its 3-second reply window), then edits in the real answer once it's ready.

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

## Tests

```bash
npm run typecheck
npm test
```

Real end-to-end coverage throughout: fixture MCP servers (stdio + Streamable HTTP), real Chromium automation (`npx playwright-core install chromium` first), real subprocess/network tests for the IoT and DevOps tool wrappers, and a real WebSocket/subprocess harness for the web server.
