# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project
doesn't yet follow Semantic Versioning releases (still pre-1.0, no
tagged releases) — entries accumulate under **Unreleased** until the
first tagged release.

## Unreleased

### Added

- CI (GitHub Actions): typecheck, lint, and the full real end-to-end
  test suite on every push/PR.
- `oxlint` for fast linting (`npm run lint`).
- Dependabot config for routine npm/Actions dependency updates.
- `Dockerfile` and `docker-compose.yml` to run the web server in a
  container, documented in the README.
- [`docs/plugins.md`](docs/plugins.md): the plugin SDK contract
  (`registerTools`/`registerCommands`, risk levels, trust gate, current
  limitations).
- `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` (MIT).
- The web server now loads a project's `.finanfa-code/plugins/`, same as
  the CLI already did.
- Two new LLM providers, both reusing the Claude Messages API request/
  response handling: `amazon-bedrock` (AWS SigV4 auth via the standard
  AWS credential chain) and `google-vertex` (Google Application Default
  Credentials). See the README's Setup section.
- An inbound Slack channel: `POST /api/channels/slack/events` on the web
  server, signature-verified, one persistent session per thread. See the
  README's new Channels section.
- An inbound Telegram channel: `POST /api/channels/telegram/webhook`,
  secret-token-verified, one persistent session per chat (or per forum
  topic). Also adds a `send_telegram_message` builtin tool.
- An inbound Discord channel: `POST /api/channels/discord/interactions`,
  Ed25519-signature-verified, a single `/ask` slash command per channel
  session, deferred-then-PATCHed since a turn outlasts Discord's 3-second
  reply window. Also adds a `send_discord_message` builtin tool.
- `transcribe_audio` builtin tool: speech-to-text via OpenAI's Whisper
  API, the counterpart to the existing `text_to_speech` tool.
- A semantic ("vector") mode for `recall_past_sessions`, alongside the
  existing full-text search — finds a conceptually related past session
  with no shared keywords. Content-hash-keyed embeddings cache in the
  same SQLite database as the FTS5 index; needs `OPENAI_API_KEY`.
- `finanfa --acp`: a real [Agent Client Protocol](https://agentclientprotocol.com/)
  agent over stdio, so an ACP-aware editor (Zed) can drive this project's
  agent loop directly — same tools/permissions/hooks/trust gate as every
  other entry point. Verified against the official ACP SDK's own client.
  `ToolCallAnnouncement` gained a `toolCallId` field and `UIAdapter` a new
  optional `writeToolResult` hook to support it.
- `read_1password_secret`/`read_vault_secret` builtin tools, wrapping the
  user's own already-authenticated `op`/`vault` CLIs (only registered
  when installed).

### Changed

- Session transcripts are now scrubbed of secret-shaped/denylisted values
  (this project's own configured provider API keys, channel signing
  secrets/bot tokens, and generic secret patterns like AWS/Stripe/GitHub
  keys) before `persist()` writes them to disk — a tool's raw output (a
  1Password/Vault secret read, an error message echoing a bad token) no
  longer lands verbatim in a session file, its resume path, or the FTS5/
  embeddings search index (both re-read the same persisted file).
- Outbound Slack/Telegram/Discord message sends now retry on a network
  failure, a 429 (honoring the platform's own rate-limit wait), or a
  5xx, instead of failing permanently on the first transient error —
  a confirmed gap relative to every channel plugin in a comparable
  project we audited against.

- `finanfa --acp`'s permission requests now carry the real tool_use id
  (the same one the `tool_call` notification for that call uses), instead
  of a synthetic `permission-<timestamp>` id unrelated to it — an ACP
  client can now actually correlate a `session/request_permission` with
  the `tool_call`/`tool_call_update` pair it's about.

- `recall_past_sessions` now wraps its results the same way `web_fetch`/
  `web_search` already do — a recalled excerpt is a past session's own
  user-typed text (a pasted web page, an email, arbitrary file contents),
  so it carries the same prompt-injection risk as any other external
  content re-entering the model's context, doubly so across projects
  (`scope: "all"`).

- The Telegram inbound channel now dedups on Telegram's own `update_id`
  (bounded in-memory tracker) — a webhook redelivery (a slow turn missing
  Telegram's own delivery timeout, a restart replaying queued updates) no
  longer runs a second full agent turn or posts a duplicate reply.

- The Telegram inbound channel now handles voice notes: downloads the real
  audio via the Bot API, transcribes it (the same OpenAI Whisper backend
  as the `transcribe_audio` tool, needing its own `OPENAI_API_KEY`), and
  runs the turn on the transcript exactly as if it had been typed —
  previously a voice note had no `text` field and was silently ignored.

- `write_memory` now warns (without blocking the save) when a new note's
  description looks like a near-duplicate of an existing one in the same
  scope saved under a different name — the memory instructions already
  said to check for this first; this catches it when that step is missed.

- The Slack inbound channel now handles image attachments (a `file_share`
  message): downloads the real bytes with the bot token and forwards them
  as an image to the model, through the same configured vision-route
  fallback every other front-end already uses — previously a `file_share`
  subtype was unconditionally ignored, silently dropping the whole
  message, image and caption both.

- The Discord inbound channel (`/ask`) now accepts an optional `image`
  attachment option, downloaded from Discord's CDN (public, no bot token
  needed) and forwarded to the model through the same configured
  vision-route fallback as the Slack/CLI/web/VS Code image paths — see
  the README's updated command-registration curl for the new option.

- Anthropic extended thinking (direct API, Bedrock, and Vertex — all
  three funnel through `streamAnthropicTurn`): opt-in via
  `/config set thinkingBudgetTokens <n>`. Thinking/redacted_thinking
  blocks round-trip through session history exactly as Anthropic requires
  (ahead of any text/tool_use, unmodified) so a tool-calling turn that
  used thinking doesn't break on its very next request. Streamed thinking
  text is available to a UI adapter via the new optional
  `writeThinkingDelta` hook. Undefined/unset budget is unchanged behavior
  — every existing session is unaffected until explicitly configured.

- A new `cohere` LLM provider — Cohere's Chat API v2, real streaming
  (text and tool-call deltas), system prompt, and tool definitions, via
  the official `cohere-ai` SDK. See the README's Setup section.
- `list_available_models` builtin tool: lists the real models an
  `amazon-bedrock` account can call (`ListFoundationModels` +
  `ListInferenceProfiles`), so picking a model id doesn't require
  digging through the AWS console first. Every other provider here
  (Anthropic, Cohere, Gemini, Azure OpenAI, an OpenAI-compatible
  endpoint, and Google Vertex AI — confirmed against `@google-cloud/
  aiplatform`'s own `ModelGardenServiceClient`, which has no listing
  method for a publisher's models) has no equivalent live discovery API
  to query, and the tool says so plainly rather than guessing.

- A new `github-copilot` LLM provider — GitHub's OAuth device-authorization
  flow (see the README's new setup section) obtains a GitHub token, which
  is exchanged (and cached/refreshed automatically) for a short-lived
  Copilot API token on every turn; the actual chat completions call reuses
  OpenAiCompatibleProvider's own request/SSE-streaming primitives, since
  Copilot's endpoint speaks the same OpenAI-compatible wire format.

- A tool call's name is now surfaced (`StreamTurnParams.onToolCallStart`,
  `UIAdapter.writeToolCallStarting`) the moment it's known mid-stream —
  Anthropic (direct/Bedrock/Vertex, via `content_block_start`), OpenAI-
  compatible, GitHub Copilot, and Cohere all fire it — instead of only
  after the whole turn finishes and `assistantMessage.toolCalls` becomes
  available. The CLI's spinner now updates to "calling &lt;tool&gt;..."
  live, rather than sitting behind a generic "thinking..." for a long
  tool-calling turn's entire duration.

- `tmux_list_sessions`/`tmux_new_session`/`tmux_send_keys`/`tmux_capture_pane`/
  `tmux_kill_session` builtin tools (only registered when `tmux` is
  installed): lets the agent drive an already-running interactive program
  (a REPL, an install wizard, a long-lived dev server) the way a human at
  a terminal would, instead of only ever running a command to completion.

- `debug_python_traceback`/`debug_node_traceback` builtin tools: run a
  real script and, on an uncaught exception, capture more than a plain
  `python3 script.py`/`node script.js` run would show on its own — Python
  gets the failing frame's actual local variable values (post-mortem
  inspection), Node gets `.cause` chains, `AggregateError.errors`, and any
  custom error properties. For genuinely interactive step-through
  debugging, run `python3 -m pdb`/`node inspect` inside a tmux session
  instead (see the new tmux tools above).

- `web_fetch` (riskLevel "safe" — no human confirmation) now runs every
  URL, and every redirect hop it follows, through a real SSRF guard: only
  http/https, no embedded credentials, and the actual resolved IP (not
  just the hostname string, which DNS rebinding could otherwise get
  around) must be a public address — blocks cloud metadata endpoints
  (169.254.169.254) and other internal/private targets a page's own
  content or a search result could otherwise steer the agent into
  fetching. Deliberately not applied to `http_request` (riskLevel "ask",
  and its own documented job is testing a locally-running API).

### Fixed

- A critical arbitrary-file-read advisory in `vitest` (<3.2.6, dev-only)
  by upgrading to v5.
- A moderate prototype-pollution/DoS advisory in `qs` (via
  `express`/`body-parser`, a real running dependency of `web-server`).
- Plugin loading (`.finanfa-code/plugins/`) previously ran unconditionally,
  before the folder-trust prompt — now gated on the same trust decision
  as `.finanfa-code/settings.json` hooks, since a plugin is arbitrary
  imported JS, not inert config.

## 0.1.0

Initial development version — a from-scratch AI coding agent (terminal
UI via Ink, browser UI via a WebSocket server + React client, VS Code
extension), with a pluggable LLM backend (Anthropic or any
OpenAI-compatible endpoint), 90+ builtin tools, MCP support, permissions,
hooks, skills, memory, and a plugin system. See the
[README](README.md) for the full feature set.
