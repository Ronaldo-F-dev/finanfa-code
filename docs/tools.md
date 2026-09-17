# Tools

90+ builtin tools, each gated by a risk level (`safe` / `ask` / `dangerous`)
enforced through the permission system. A tool that needs an external CLI
or credential is only registered when that dependency is actually
present — see each entry below for what's needed.

## Files & code

`read_file`, `write_file`, `edit_file`, `multi_edit_file`, `glob`, `grep`

`read_file`/`write_file`/`edit_file` work within the project root or the
user's home directory; nothing outside either is reachable through these
tools (`bash` has no such boundary).

## Shell & processes

`bash`, `run_tests`, `start_background_process` / `list_background_processes` / `stop_background_process`, `wait_for_port`

## Git

- Safe: `git_status`, `git_diff`, `git_log`, `git_branch`, `git_fetch`
- Ask: `git_add`, `git_commit`, `git_checkout`, `git_push`, `git_pull`, `git_stash`

## Web & browser

`web_search`, `web_fetch`, `http_request`, `browser_navigate` / `browser_click` / `browser_screenshot` (Playwright/Chromium), `preview_html`

Results from `web_search`/`web_fetch`/`browser_*` are wrapped as untrusted
content — treated as data, not instructions, to reduce prompt-injection
risk from a fetched page.

## Documents

`read_document` / `write_document` / `edit_document` (PDF, Word, Excel, CSV), `write_spreadsheet` / `edit_spreadsheet` / `merge_spreadsheets`, `merge_pdf` / `split_pdf` / `images_to_pdf` / `convert_pdf_to_image`, `convert_to_pdf`, `convert_spreadsheet`, `ocr_image`, `read_notebook` / `edit_notebook`

## Images

`view_image`, `resize_image`, `generate_2d`, `generate_3d`

`generate_2d` generates a real image via OpenAI's Images API (`gpt-image-1`)
when `OPENAI_API_KEY` is set — a real, metered call. Without a key, it
reports unavailable rather than failing silently.

`generate_3d` is an honest stub: no image-to-3D provider is wired in yet
(self-hosting SAM 3D/TRELLIS needs 24–32GB of VRAM; no paid API is
configured). It always reports unavailable.

## Video & music generation

`generate_video` / `generate_music` — needs `REPLICATE_API_TOKEN`. Real,
billed generation via any [Replicate](https://replicate.com) model (e.g.
`minimax/video-01` for video, `meta/musicgen` for music); the model's own
input fields are passed straight through rather than a fixed schema,
since every Replicate model's input is different — check the model's own
page on replicate.com.

## Video understanding

`view_video_frames` (needs `ffmpeg`/`ffprobe`) samples a handful of
evenly-spaced still frames from a video (no motion/timing/audio).
`analyze_video` (needs `GEMINI_API_KEY`, independent of the primary chat
provider) is real native video+audio understanding via Gemini. A video
under ~19MB is sent inline; up to 200MB goes through Gemini's real,
resumable-upload File API instead.

## Voice & messaging

`text_to_speech` (free, Google Translate backend), `transcribe_audio`
(Whisper, needs `OPENAI_API_KEY`), `send_email`, and one outbound tool per
chat platform — see [channels.md](channels.md) for the full list and the
inbound (bot) side of each.

## Productivity

`read_notion_page` / `write_notion_page` (needs `NOTION_API_KEY`), `create_trello_card` (needs `TRELLO_API_KEY`/`TRELLO_API_TOKEN`), `get_spotify_now_playing` / `control_spotify_playback` (needs `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`/`SPOTIFY_REFRESH_TOKEN`)

## Smart home

`get_smart_home_state` / `control_smart_home_device` — needs `HOME_ASSISTANT_BASE_URL`/`HOME_ASSISTANT_TOKEN`. Home Assistant's own REST API covers thousands of real device integrations behind one interface.

## Code quality

`check_python_types` (Pyright), `check_typescript_types` (tsc), `lint_javascript` (ESLint), `lint_python` (ruff)

## Data

`query_database` (SQLite/Postgres/MySQL), `python_repl` (persistent interpreter)

## UI generation

`create_artifact` — React + Tailwind, live preview.

## Delegation

`task` (sub-agents, optionally a named `agentType` — see
[configuration.md](configuration.md#agent-types)), `todo_write` (shown
live in the web UI as a Kanban-style board, not just a text checklist)

`delegate_to_claude_code` / `delegate_to_codex` (when the `claude`/`codex`
CLI is installed) hand a task to a completely separate coding-agent CLI —
its own model, tools, and context — as a generic argv passthrough.

## IoT / embedded

`serial_*`, `run_esptool` / `run_avrdude`, `mqtt_publish` / `mqtt_subscribe`, `coap_request`, `gpio_*`, `run_arduino_cli` / `run_platformio`

## DevOps

`run_docker`, `run_kubectl`, `run_mydevops` (when installed)

## Fleet (multi-tenant container hosting)

Needs `docker`. Provisions and manages isolated per-tenant containers
("cells"): `create_fleet_cell` / `list_fleet_cells` / `stop_fleet_cell` /
`remove_fleet_cell` / `create_fleet_network` / `remove_fleet_network`.
Every cell is named with a fixed prefix so these tools can only ever
affect containers they created themselves.

Supports real Docker resource limits (`--memory`/`--cpus`), a restart
policy, a health check (surfaced as healthy/unhealthy in
`list_fleet_cells`), a shared network so cells reach each other by name,
and placing a cell on a **remote** machine via a real `DOCKER_HOST`
value (e.g. `ssh://user@remote-machine`).

**Multi-host scheduling**: `register_fleet_host` / `list_fleet_hosts` /
`remove_fleet_host` maintain a pool of hosts
(`~/.finanfa-code/fleet-hosts.json`). `create_fleet_cell` without an
explicit `host` auto-schedules onto whichever registered, reachable host
currently has the fewest running cells — a live check at schedule time,
not bin-packing by CPU/memory telemetry or a persistent scheduling
daemon.

## Remote execution / node-host

Needs `ssh`. `run_remote_command` runs a command on another machine over
your own already-configured SSH (host aliases/keys/agent from
`~/.ssh/config`), `riskLevel: dangerous`. An optional `retries` (default
0) retries a transient *connection* failure with backoff — never once
the remote command itself actually ran and returned its own exit code
(ssh's own exit 255 is the signal used to tell those apart), so only set
it above 0 for a command that's safe to run more than once.

`register_remote_host` / `list_remote_hosts` / `remove_remote_host` /
`check_remote_host_health` maintain a named registry of remote machines
(`~/.finanfa-code/remote-hosts.json`) with a live health probe (uptime +
disk usage over SSH, retried automatically on a transient connection
failure).

## macOS UI automation

`run_applescript` (macOS only) drives other applications (Finder, Mail,
Music, System Events) via a real AppleScript.

## Secrets

`read_1password_secret` (via the `op` CLI), `read_vault_secret` (via the
`vault` CLI) — both `riskLevel: dangerous`, only registered when the
underlying CLI is installed.

## Security scanning

Prompt injection / jailbreak / system-prompt-leak / PII-leakage /
excessive-agency self-red-team, plus SSRF / XSS / SQLi / XXE / SSTI /
IDOR / CSRF / JWT / LDAP-injection / subdomain-takeover / recon /
email-security / and more against a target URL.

## Session & memory

`recall_past_sessions` — full-text search over past sessions, plus an
optional semantic mode (needs `OPENAI_API_KEY`).

`write_memory` / `delete_memory` / `search_memories` / `find_duplicate_memories`
— see [configuration.md](configuration.md#memory) for the full memory
system, including provenance tracking and semantic search.

## Observability

`read_traces` (OpenTelemetry tool-call/LLM-turn durations and error
rates), `read_audit_log` (structured permission-decision audit trail —
see [security.md](security.md))
