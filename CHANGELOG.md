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

- OpenAI-compatible and Cohere providers now repair a tool call's
  arguments JSON when a stream disconnected before it closed (unclosed
  braces/brackets/quotes, a trailing comma the closing exposed) instead of
  asking the model to redo the whole call — the single most common real
  cause of a "malformed tool-call arguments" failure. Deliberately skipped
  when the disconnect was the model hitting its own max-output-token
  limit: there the argument's own *content* (not just its JSON envelope)
  is genuinely incomplete, and the existing truncation marker still
  applies so the model knows to actually recover instead of silently
  running with cut-off data.

- `ask_user` builtin tool: lets the model pause mid-turn and ask a direct
  question when it genuinely needs information only the user can provide
  (a real choice, a value it can't infer), then keep working with the
  answer in the same tool-calling loop — previously the only option was
  ending the whole turn on a text question and waiting for the next
  message.

- A new inbound WhatsApp channel (WhatsApp Cloud API):
  `GET`/`POST /api/channels/whatsapp/webhook` — Meta's own verification
  handshake, X-Hub-Signature-256 HMAC verification on every event,
  dedup on WhatsApp's own message id, one persistent session per sender.
  Also adds a `send_whatsapp_message` builtin tool. See the README's new
  WhatsApp setup section.

- A new inbound SMS channel (Twilio Programmable Messaging):
  `POST /api/channels/sms/webhook` — Twilio's own URL+params HMAC-SHA1
  request-validation scheme (verified against Twilio's own published test
  vector), dedup on Twilio's own MessageSid, one persistent session per
  sender. Also adds a `send_sms_message` builtin tool. See the README's
  new SMS setup section.

- Path-scoped project instructions: `.finanfa-code/instructions/*.md`,
  with frontmatter `applyTo` (a glob or list of globs) — for conventions
  that only apply to one part of a monorepo instead of competing for
  attention in one whole-project `finanfa.md`. Folded into the system
  prompt at every entry point, each labeled with its own globs.

- `fly.toml` and `render.yaml` — ready-to-use Fly.io/Render.com deployment
  configs for the web server, both building the existing Dockerfile with
  no changes needed to it. See the README's new Fly.io/Render.com section.

- `delegate_to_claude_code`/`delegate_to_codex` builtin tools (only
  registered when the `claude`/`codex` CLI is installed): hand a real
  coding task to a completely separate coding-agent CLI running in a
  given directory, with its own model/tools/context — not a sub-agent of
  this session's own `task` tool. A generic argv-passthrough wrapper (same
  shape as `run_mydevops`) rather than a fixed "prompt only" abstraction,
  since either CLI's exact current flags are best discovered via its own
  `--help` rather than hardcoded here.

- A structured, security-focused audit trail: every permission decision
  (allow/deny, and which code path decided it — a PreToolUse hook,
  `--yolo`, the session allowlist, a config rule, the risk-level default,
  or a direct user answer) is appended to `~/.finanfa-code/audit/
  <date>.jsonl`, one JSON line per decision. Independent of the existing
  OpenTelemetry trace file (perf-only, and a denied call never reaches
  it) and the session transcript (no explicit decision/reason recorded).
  New `read_audit_log` builtin tool to query it. See the README's
  updated Security section.

- `read_notion_page`/`write_notion_page` builtin tools: a real Notion API
  connector (needs `NOTION_API_KEY`, an internal integration token shared
  with the target page) — reads a page's direct content as plain text, or
  appends plain-text paragraph blocks to it. One of the productivity
  integrations (Notion/Trello/Spotify/...) flagged as a gap relative to a
  comparable project we audited against.

- `create_trello_card` builtin tool: a real Trello REST API connector
  (needs `TRELLO_API_KEY`/`TRELLO_API_TOKEN`) — creates a card on a given
  list. Another of the same productivity-integration gaps.

- `get_spotify_now_playing`/`control_spotify_playback` builtin tools: a
  real Spotify Web API connector (needs `SPOTIFY_CLIENT_ID`/
  `SPOTIFY_CLIENT_SECRET`/`SPOTIFY_REFRESH_TOKEN` — a one-time OAuth
  authorization, unlike Notion's/Trello's static tokens, since Spotify
  access tokens expire hourly) — reports the currently playing track, or
  controls play/pause/skip on the active device. The last of the
  productivity integrations (Notion/Trello/Spotify) named as a gap
  relative to a comparable project we audited against.

- `delete_memory` builtin tool (a memory note could previously only be
  written/overwritten by the agent, never removed by it — only a human
  via the web UI's Memory panel had a delete path) and
  `find_duplicate_memories`: scans every saved note for likely
  near-duplicates (the same pairwise check `write_memory` already ran
  against a single new note, extended over the whole store) so they can
  be reviewed and merged. A pragmatic, tool-driven stand-in for a
  persistent background "dreaming"/consolidation process — this project
  has no long-running service to run one in, so consolidation here is
  explicitly triggered and acted on by the agent, not automatic.

- `analyze_video` builtin tool: real native video+audio understanding
  via Gemini's multimodal API (`GEMINI_API_KEY`, independent of whatever
  the primary chat provider is), sent inline (a real ~19MB ceiling —
  larger videos are reported as out of scope, not routed through
  Gemini's separate Files API/resumable-upload protocol, a genuinely
  bigger integration to get right without a real account to verify it
  against). Closes the "deeper multimodal understanding beyond Whisper"
  gap for real — unlike `view_video_frames`'s still-frame sampling, this
  actually sees the video's real motion and audio together.

- `generate_2d` now really generates an image, via OpenAI's Images API
  (`gpt-image-1`, `OPENAI_API_KEY` — the same key `transcribe_audio`/
  `recall_past_sessions`' semantic mode already use), instead of always
  reporting unavailable. `riskLevel` moved from "safe" to "ask" — a real,
  metered API call, and an optional file write. Still reports unavailable
  when `OPENAI_API_KEY` isn't set. `generate_3d` remains an honest stub
  (still no viable image-to-3D provider).

- "Fleet": `create_fleet_cell`/`list_fleet_cells`/`stop_fleet_cell`/
  `remove_fleet_cell` builtin tools (only registered when `docker` is
  installed) — provisions and manages isolated per-tenant containers
  ("cells") on the Docker daemon this process can already reach, wrapping
  the real `docker` CLI the same way `run_docker`/`run_mydevops` already
  do. Every cell is named with a fixed prefix so these tools can only
  ever affect a container they created themselves. Closes the multi-
  tenant sandboxed hosting gap relative to a comparable project's own
  Fleet — deliberately scoped to managing cells on one existing Docker
  daemon, not a multi-node/multi-host scheduler placing cells across a
  real fleet of machines.

- `generate_video`/`generate_music` builtin tools: real, billed video and
  music generation via any Replicate model (`REPLICATE_API_TOKEN`) —
  passes the model's own real input fields straight through rather than
  a fixed schema (every Replicate model's input is genuinely different),
  polls the real prediction until it finishes, downloads the real output,
  and saves it. Closes the video/music generation gap: neither OpenAI
  nor Gemini has a broadly-available, non-invite-only API for this today,
  but Replicate hosts real open models for both behind one ordinary API
  token, no special access needed.

- Gateway gains real OIDC-based SSO (`FINANFA_WEB_OIDC_ISSUER`/
  `FINANFA_WEB_OIDC_CLIENT_ID`/`FINANFA_WEB_OIDC_CLIENT_SECRET`/
  `FINANFA_WEB_OIDC_REDIRECT_URI`) — a real Authorization Code + PKCE
  flow (`GET /api/auth/oidc/login` redirects to the provider,
  `GET /api/auth/oidc/callback` completes it and issues a real session
  token identical to a password login's), independent of and combinable
  with static tokens/password accounts. Trusts the provider's userinfo
  endpoint for identity instead of verifying the ID token's JWT signature
  locally — a real, documented simplification many minimal OIDC clients
  make, not a silent gap. Closes the OAuth/SSO half of the Gateway gap.

- `analyze_video` now supports videos up to 200MB (previously ~19MB),
  via Gemini's real File API — Google's own documented resumable-upload
  protocol (announce the upload, get a one-time upload URL back via a
  response header, upload+finalize the bytes, poll until the file's
  real server-side processing reports it ready, reference it by
  `file_uri` in `generateContent`, then delete it) — reproduced
  faithfully from Google's published example, not guessed at, though
  still unverified against a real live account (none available to test
  against). A video under ~19MB still goes the simpler inline route.
  Closes the practical size ceiling half of the earlier multimodal gap.

- node-host gains a real known-hosts registry: `register_remote_host`/
  `list_remote_hosts`/`remove_remote_host`/`check_remote_host_health`
  (`~/.finanfa-code/remote-hosts.json`) — a persistent, named list of
  remote machines with a real, live health probe (uptime + disk usage
  over SSH, reusing `run_remote_command`'s own argv-building/subprocess
  runner so it's exactly the same real SSH invocation shape, not a
  second implementation). Still not a deployed agent process on each
  remote node — health means "can I reach it and run a command right
  now," checked live each time, not a persistent heartbeat this project
  receives.

- Claws bundles are now cryptographically signed (Ed25519, a stable
  per-machine identity auto-generated at `~/.finanfa-code/claws-
  identity.json`) — `install_bundle` verifies the signature (catches
  tampering/corruption in transit) and reports whether this machine has
  seen that publisher's key before (`~/.finanfa-code/claws-trusted-
  publishers.json`), plus a real semver-ish comparison against whatever
  version of that bundle name was last installed into this project
  (`.finanfa-code/.claws/installed.json`) — new/upgrade/downgrade/
  reinstall. Closes the "provenance is just an unverified string" half
  of the Claws gap. Also fixes a real snapshot-id collision: two installs
  landing in the same millisecond used to silently overwrite each
  other's rollback snapshot.

- Fleet now supports real Docker resource limits (`memory_limit`/`cpus`),
  a restart policy, a real HEALTHCHECK (reported back as healthy/
  unhealthy in `list_fleet_cells`, no extra polling needed — Docker's own
  `docker ps` status string already carries it), a shared network
  (`create_fleet_network`/`remove_fleet_network`, same fixed-prefix
  isolation as cells) so cells can reach each other by name, and a real
  remote host per cell/network/list/stop/remove call (a real
  `DOCKER_HOST` value, e.g. `ssh://user@remote-machine`, over the user's
  own already-configured SSH — the actual, standard way the `docker` CLI
  itself supports a remote daemon, no bespoke protocol or agent to
  deploy). Still doesn't do cross-host scheduling/placement on its own —
  the caller picks the host explicitly.

- Gateway now supports real per-login accounts (`FINANFA_WEB_ACCOUNTS=1`),
  not just a static shared-secret token map: hashed passwords (scrypt,
  random salt per password) persisted to `~/.finanfa-code/web-users.json`,
  `POST /api/auth/users` (bootstraps with no auth for the very first
  account, requires an existing valid token for every one after) and
  `POST /api/auth/login` issuing a real, opaque, in-memory session token
  (30-day expiry) — authenticates identically to a static
  `FINANFA_WEB_USERS` token everywhere else (REST, WebSocket, session
  ownership). The two mechanisms are independent and can be combined.
  Closes the "real user accounts, not a shared secret" half of the
  Gateway gap.

- Fleet gains a real multi-host scheduler: `register_fleet_host`/
  `list_fleet_hosts`/`remove_fleet_host` maintain a persistent pool of
  Docker hosts (`~/.finanfa-code/fleet-hosts.json`, local or remote via
  a real `DOCKER_HOST` value); `create_fleet_cell` now auto-schedules
  onto whichever registered, reachable host currently has the fewest
  running cells (a real, live `docker ps`/`docker version` check per
  host at schedule time) when no explicit `host` is given, falling back
  to the local daemon exactly as before when no hosts are registered at
  all. Closes the cross-host scheduling/placement half of the Fleet
  gap — still live-load placement only, not bin-packing by actual
  CPU/memory telemetry, live migration of an already-running cell, or a
  persistent scheduling daemon.

- Claws gains a real hosted registry: `publish_bundle_to_registry`/
  `list_registry_bundles`/`list_registry_bundle_versions`/
  `install_bundle_from_registry` publish to and install from any GitHub
  repository the user (or their org) already controls, via GitHub's own
  real Contents API (`bundles/<name>/<version>.json`, committed like
  any other file) rather than a bespoke multi-tenant discovery service
  this project would have to operate itself. Published versions are
  immutable, same convention as a real package registry. Closes the
  "publish/discover bundles from others" half of the Claws gap —
  sharing a bundle's JSON directly (a gist, a file attachment) still
  works exactly as before.

- Gateway session tokens (from a password login or OIDC SSO) are now
  persisted to `~/.finanfa-code/web-sessions.json` instead of living
  only in the server process's memory — a restart (redeploy, crash) no
  longer forces every logged-in user to log in again. Validating a
  token stays synchronous/memory-only (no disk I/O added to the
  authenticated-request hot path); only issuing/revoking a session
  persists.

- `run_remote_command` gains an opt-in `retries` (default 0, unchanged
  behavior) that retries a transient SSH CONNECTION failure with
  backoff — a network blip, a briefly-unreachable host — but never once
  the remote command itself actually ran and returned its own exit code
  (ssh's own documented exit 255 is the real signal used to tell those
  apart, the same one real remote-automation tools like Ansible rely
  on), so retrying never risks silently re-running a command that
  already executed. `check_remote_host_health`'s own probe (read-only,
  idempotent) now always retries a couple of times on a transient
  connection failure before actually reporting a host unhealthy.

- `analyze_video`'s File API path (see above) is now confirmed end to
  end against a real, live Gemini account — a real ~21MB generated
  video, forcing the exact path a smaller test file can't reach. That
  real run surfaced two genuine bugs, both now fixed: `DEFAULT_MODEL`
  had drifted to a since-deprecated model name (Gemini's own API told
  new callers to migrate off it — updated to Google's own currently-
  recommended one), and `startResumableUpload`/`finalizeResumableUpload`
  had no retry at all unlike `generateContentWithPart`'s own
  `fetchWithRetry` — a transient network blip partway through a real
  multi-minute upload reliably reproduced the whole flow failing
  outright. Both upload steps now share the same retry as the rest of
  this file; the file-status poll no longer aborts the whole wait on a
  single transient network error either, just tries again next interval.

- "Gateway": opt-in multi-user authentication for the web server
  (`FINANFA_WEB_USERS="alice:token1,bob:token2"`) — a Bearer token on
  every `/api/*` request (channel webhooks keep their own signature
  verification instead) and a `?token=` query param on the WebSocket
  upgrade, plus per-user session isolation (`AgentSession.ownerUser`,
  persisted): a user can only list/resume/delete their own sessions, not
  another user's. Off by default — every existing single-user deployment
  is unaffected. Closes the multi-user/multi-client control-plane gap
  relative to a comparable project's own Gateway, scoped to
  authentication + per-user session isolation within this one process,
  not a separate service coordinating multiple downstream agent
  instances.

- "Claws": `export_bundle`/`install_bundle`/`list_bundle_snapshots`/
  `rollback_bundle` builtin tools — package a project's whole
  finanfa-code configuration (permission rules/hooks, MCP servers,
  memory, skills, commands, agent types, instructions, finanfa.md/
  finanfa-design.md) into one shareable, versioned JSON bundle, with
  provenance and rollback (every file an install touches is snapshotted
  first). Closes the versioned-bundle gap relative to a comparable
  project — deliberately scoped to the bundle format and local install/
  rollback mechanism, not a hosted registry to discover bundles others
  published (that's a separate, much larger gap — running a real
  multi-tenant discovery service — genuinely out of scope here).

- `run_remote_command` builtin tool (only registered when `ssh` is
  installed): runs a command on a separate machine over the user's own
  already-configured SSH (host aliases/keys/agent from their real
  `~/.ssh/config` — no credentials of its own), non-interactively
  (BatchMode). Closes the "node-host" distributed remote-execution gap
  relative to a comparable project. Deliberately doesn't shell-
  retokenize the remote command locally (unlike `runSubprocess`'s usual
  shell:true+args behavior) — a command containing `$(...)`/backticks/
  quotes is meant for the *remote* shell to interpret, not the local one.

- `get_smart_home_state`/`control_smart_home_device` builtin tools: a
  real Home Assistant REST API connector (needs `HOME_ASSISTANT_BASE_URL`/
  `HOME_ASSISTANT_TOKEN`, a long-lived access token from Home Assistant's
  own Profile page) — reads an entity's state/attributes, or turns a
  device on/off/toggles it. Closes the smart-home integration gap
  relative to a comparable project we audited against; wrapping Home
  Assistant's own REST API covers thousands of real device integrations
  behind one interface, rather than integrating any single vendor
  directly.

- A new inbound Voice channel (Twilio Programmable Voice):
  `POST /api/channels/voice/webhook` (a new call) and
  `POST /api/channels/voice/gather` (the caller's spoken reply), both
  signature-verified. Closes the real-time voice/telephony gap relative
  to a comparable project we audited against — with an honest limit
  Twilio's own synchronous webhook forces: a turn is raced against an 8s
  deadline, and past it the caller is told plainly instead of left on
  hold, with a best-effort SMS follow-up once the turn actually finishes
  (when SMS is also configured for the same number). Each call gets its
  own session (keyed by CallSid), not a persistent per-sender thread like
  SMS/WhatsApp.

- The web UI now renders the current `todo_write` checklist as a real
  visual task board (a "Tasks" panel in the sidebar, three columns: to
  do/in progress/done) instead of only ever a plain-text log line —
  closes the "Boards/Canvas/Workboard" gap relative to a comparable
  project's own task-tracking UI. A new optional `UIAdapter.writeTodos`
  hook carries the structured checklist over the existing WebSocket
  protocol (a `"todos"` event); the terminal/ACP adapters are unaffected,
  still relying on the existing plain-text echo. The checklist is now
  also persisted on the session file (previously runtime-only) so a
  resumed session's board isn't empty until the next `todo_write` call.

- `view_video_frames` builtin tool (only registered when `ffmpeg`/
  `ffprobe` are installed): samples a handful of evenly-spaced still
  frames from a video file (mp4/mov/webm/...) and hands them to the model
  the same way `view_image` does — real video-native understanding
  (motion, timing, audio) is explicitly out of scope; `transcribe_audio`
  already covers the audio track. Closes part of the "deeper multimodal
  understanding beyond Whisper" gap relative to a comparable project.

- `run_applescript` builtin tool (macOS only, only registered when
  `process.platform === "darwin"`): runs a real AppleScript via
  `osascript`, the standard mechanism for driving other macOS
  applications (Finder, Mail, Music, System Events for cross-app UI
  scripting) — closing the macOS UI automation gap relative to a
  comparable project's native macOS app.

- Finer-grained permission rules: a `settings.json` rule can now add
  `cwdPrefix`, scoping it to part of a monorepo (e.g. auto-allow `bash`
  inside one already-reviewed directory without loosening the default
  everywhere else) — previously a rule's only granularity was the tool
  name and its own `riskKey`-derived `keyPrefix`, with no way to scope by
  where the call actually runs.

### Fixed

- Flaky web-server e2e tests: `spawnWebServer` (shared by ~15 test files)
  now spawns the real server with `PORT=0` and reads back the actual
  OS-assigned port from its startup log, instead of guessing one in a
  caller-supplied range — several ranges overlapped, and running test
  files in parallel could collide on the same port, failing with a
  "bad port"/connection-refused error unrelated to the code under test.

- `mask()` (secret redaction, see `redact.ts`): threw `RangeError: Invalid
  count value` for a 9-character value instead of masking it — its
  first-6/last-4 scheme needs more than 10 characters to have any real
  middle left to mask. Found while adding a new `redactSecrets` caller
  (todo persistence): a test elsewhere restoring `process.env.X =
  originalValue` where `originalValue` was `undefined` had been silently
  setting `X` to the literal string `"undefined"` (Node doesn't unset an
  env var that way) — 9 characters — which then flowed into every later
  test's redaction denylist in the same file.

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
