# finanfa-code

A from-scratch AI coding agent CLI, built in TypeScript on the Anthropic Messages API.

## Status

All 4 phases implemented:

1. Core agent loop — streaming conversation, session persistence, resume, cost tracking, prompt caching.
2. Built-in tools — `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash` — gated by a three-state permission model (allow/ask/deny) with a session "always allow" allowlist.
3. Terminal UI — Ink (React) by default, with a `readline` fallback for non-TTY/CI use.
4. Extensibility — MCP client (stdio servers), a filesystem plugin loader, and Markdown skill files.

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

## Commands

- `/cost` — token usage and estimated cost for the session
- `/sessions` — list saved sessions for this directory; `/sessions delete <id>` removes one
- `/mcp list` / `/mcp reload` / `/mcp add <name> -- <command> [args...]` — manage MCP servers
- `/exit` — quit

## CLI flags

- `-r, --resume <sessionId>` / `-c, --continue`
- `-m, --model <model>`
- `--yolo` — auto-approve every tool call (dangerous, opt-in)
- `--non-interactive` — never prompt; auto-deny anything not pre-allowed by config
- `--ui <ink|readline>`

## Project-local configuration (`.finanfa-code/`)

- `settings.json` — permission rules (see `src/permissions/config.ts` for the shape)
- `mcp.json` — `{ "servers": [{ "name": "...", "transport": "stdio", "command": "...", "args": [...] }] }`
- `plugins/<name>/index.js` — exports `registerTools(registry)` and/or `registerCommands(commands)`
- `skills/*.md` — frontmatter (`name`, `description`) + body; the full body is loaded on demand via the `read_skill` tool

## Tests

```bash
npm run typecheck
npm test
```

Includes a real end-to-end test that spawns a fixture MCP server over stdio (`test/mcp/client-manager.test.ts`).
