# finanfa-code

A from-scratch AI coding agent CLI, built in TypeScript, with a pluggable LLM backend (Anthropic, or anything speaking the OpenAI chat-completions wire format — Ollama, OpenRouter, Poolside, LM Studio, vLLM, ...).

## Status

All 4 phases implemented, plus a multi-provider backend:

1. Core agent loop — streaming conversation, session persistence, resume, cost tracking, prompt caching.
2. Built-in tools — file/shell/search/browser/planning tools (full list below) — gated by a three-state permission model (allow/ask/deny) with a session "always allow" allowlist.
3. Terminal UI — Ink (React) by default, with a `readline` fallback for non-TTY/CI use.
4. Extensibility — MCP client (stdio and remote HTTP/SSE + OAuth servers), a filesystem plugin loader, and Markdown skill files.
5. LLM providers — `AnthropicProvider` and a generic `OpenAiCompatibleProvider`, behind an `LlmProvider` interface; sessions/tools/permissions are provider-agnostic (`src/core/types.ts`'s `NeutralMessage`).
6. Sub-agents ("co-work") — the `task` tool delegates independent work to a sub-agent with its own conversation but the same tools/permissions; multiple `task` calls in one turn run concurrently.

## Setup

### Anthropic (default)

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

### Free / local alternative (Ollama, OpenRouter, Poolside, ...)

Any server implementing the OpenAI chat-completions API works. Example with a local, free Ollama model:

```bash
ollama pull llama3.1:8b   # a model with reliable tool-calling support — see note below
export FINANFA_PROVIDER=openai-compatible
export FINANFA_BASE_URL=http://localhost:11434/v1
export FINANFA_MODEL=llama3.1:8b
npm run dev
```

For OpenRouter or Poolside, no code changes needed — just point at their base URL:

```bash
export FINANFA_PROVIDER=openai-compatible
export FINANFA_BASE_URL=https://inference.poolside.ai/v1
export FINANFA_API_KEY=<your Poolside key>
export FINANFA_MODEL=poolside/laguna-s-2.1
npm run dev
```

> **Tool-calling reliability varies by model/provider.** Verified working end-to-end (real `tool_calls`, e.g. `glob`/`bash` actually executed): Poolside (`poolside/laguna-s-2.1`) and Ollama's `llama3.1:8b`. Poolside's responses include a `reasoning_content` field alongside `content` (thinking-by-default) — harmlessly ignored, since the provider only reads `delta.content`. Ollama's `qwen2.5-coder:7b` instead wrote the tool call as plain JSON text rather than a structured delta — the model itself doesn't reliably use function-calling with that setup, not a bug in this codebase (verified: `toOpenAiMessages`/parsing round-trip correctly in tests). Prefer a model known to support "tools"/function-calling.
>
> Streaming usage (`/cost`) reports `$0.00`/`0 tokens` for unrecognized model ids and for backends (like Ollama) that don't return `usage` in streamed responses — this is expected, not a bug.

## Commands

Type `/` to see live autocomplete suggestions (Ink UI: arrow keys to select, Tab to complete; `readline` fallback: Tab-completion).

- `/help` — list all commands with descriptions
- `/cost` — token usage and estimated cost for the session
- `/clear` — clear the conversation history (same session id)
- `/undo` — revert the most recent `write_file`/`edit_file` change made by the agent (a per-session stack, not just the last one — call it repeatedly to go further back)
- `/todos` — show the current task checklist (set by the agent via the `todo_write` tool)
- `/sessions` — list saved sessions for this directory; `/sessions delete <id>` removes one
- `/mcp list` / `/mcp reload` / `/mcp add <name> -- <command> [args...]` — manage MCP servers
- `/exit` — quit

Ctrl+C (or `kill -TERM`) triggers a graceful shutdown in both UI modes: the current session is persisted and MCP connections are closed before exit, instead of an abrupt kill.

## CLI flags

- `-r, --resume <sessionId>` / `-c, --continue`
- `-m, --model <model>`
- `--yolo` — auto-approve every tool call (dangerous, opt-in)
- `--non-interactive` — never prompt; auto-deny anything not pre-allowed by config
- `--ui <ink|readline>`

## Project-local configuration (`.finanfa-code/`)

- `settings.json` — permission rules (see `src/permissions/config.ts` for the shape)
- `mcp.json` — `{ "servers": [ ... ] }`, one entry per MCP server:
  - stdio (local process): `{ "name": "github", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }`
  - http / sse (remote server): `{ "name": "example", "transport": "http", "url": "https://mcp.example.com/mcp" }`
- `plugins/<name>/index.js` — exports `registerTools(registry)` and/or `registerCommands(commands)`
- `skills/*.md` — frontmatter (`name`, `description`) + body; the full body is loaded on demand via the `read_skill` tool

### Connecting third-party services (GitHub, etc.) via MCP

MCP is how finanfa-code connects to external accounts/services — skills and plugins are for local behavior/tools, not remote auth.

- **stdio + a personal access token** (e.g. the official GitHub MCP server) works today:
  ```bash
  export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...
  ```
  ```
  /mcp add github -- npx -y @modelcontextprotocol/server-github
  ```
- **Remote servers requiring OAuth** (e.g. Gmail, or any hosted MCP server behind a login) are supported via the `http`/`sse` transports:
  ```
  /mcp add myservice --url https://mcp.example.com/mcp
  ```
  If the server responds 401, finanfa-code opens the authorization URL in your browser (and prints it, for headless environments) via a temporary local callback server on `http://127.0.0.1:51789/callback`. Client registration and tokens are persisted per-server under `~/.finanfa-code/mcp-auth/<server-name>/`, so you only authorize once.

**More connectors (Notion, Google Drive, Figma, Trello, Spotify, ...):** the `http`/`sse` + OAuth support above works with *any* MCP server implementing the spec — it's not limited to GitHub. Notion publishes an official hosted MCP server; several of the others have community-maintained ones. Their exact URLs/packages change over time, so look up the current one for the service you want and `/mcp add <name> --url <url>` it (or the stdio form, if it's a local package) — no code changes needed here.

## Other built-in tools

- `web_search` — searches via DuckDuckGo's HTML results page; 100% free, no API key or signup required.
- `web_fetch` — fetches a specific URL and returns its text content (HTML tags stripped); use for a known link, as opposed to `web_search` for open-ended queries.
- `preview_html` — opens a local HTML file in the default browser, e.g. to show a UI mockup written with `write_file`.
- `task` — delegates a self-contained piece of work to a sub-agent (same tools/permissions, its own conversation); multiple `task` calls in one assistant turn run concurrently.
- `todo_write` — sets/replaces the task checklist shown live to the user (and via `/todos`); the agent is nudged to use it for multi-step work.
- `browser_navigate` / `browser_click` / `browser_screenshot` — real browser automation via [Playwright](https://playwright.dev) (Chromium), for JavaScript-rendered pages `web_fetch` can't handle, or to visually inspect/click through a page. One headless browser session persists across calls within a run. Requires the Chromium binary: `npx playwright-core install chromium` (not `npx playwright install` — this project depends on the lighter `playwright-core`, which has no bundled CLI download step of its own).

## Tests

```bash
npm run typecheck
npm test
```

Includes real end-to-end tests: a fixture MCP server over stdio (`test/mcp/client-manager.test.ts`) and over Streamable HTTP (`test/mcp/client-manager-http.test.ts`), unit tests for the OAuth client provider (`test/mcp/oauth-provider.test.ts`), orchestration tests for parallel `task` sub-agent execution (`test/tools/task.test.ts`), and real Chromium navigation/click/screenshot tests (`test/browser/manager.test.ts`) — the latter needs `npx playwright-core install chromium` first, same as running the tool for real.
