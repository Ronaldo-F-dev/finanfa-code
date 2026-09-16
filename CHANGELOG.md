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
