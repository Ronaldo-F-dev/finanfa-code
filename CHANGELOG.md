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
