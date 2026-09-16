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
