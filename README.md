# finanfa-code

A from-scratch AI coding agent CLI, built in TypeScript, with a pluggable LLM backend (Anthropic, or anything speaking the OpenAI chat-completions wire format — Ollama, OpenRouter, Poolside, LM Studio, vLLM, ...).

## Status

All 4 phases implemented, plus a multi-provider backend:

1. Core agent loop — streaming conversation, session persistence, resume, cost tracking, prompt caching.
2. Built-in tools — `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash` — gated by a three-state permission model (allow/ask/deny) with a session "always allow" allowlist.
3. Terminal UI — Ink (React) by default, with a `readline` fallback for non-TTY/CI use.
4. Extensibility — MCP client (stdio servers), a filesystem plugin loader, and Markdown skill files.
5. LLM providers — `AnthropicProvider` and a generic `OpenAiCompatibleProvider`, behind an `LlmProvider` interface; sessions/tools/permissions are provider-agnostic (`src/core/types.ts`'s `NeutralMessage`).

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

For OpenRouter or Poolside: set `FINANFA_BASE_URL` to their API base URL (e.g. `https://openrouter.ai/api/v1`) and `FINANFA_API_KEY` to your key.

> **Tool-calling reliability varies by local model.** Tested against Ollama: `llama3.1:8b` correctly emits structured `tool_calls`, end-to-end, including real `glob`/`bash` execution. `qwen2.5-coder:7b` instead wrote the tool call as plain JSON text rather than a structured delta — the model itself doesn't reliably use function-calling with this Ollama setup, not a bug in this codebase (verified: `toOpenAiMessages`/parsing round-trip correctly in tests). Prefer a model Ollama's library marks as supporting "tools".
>
> Streaming usage (`/cost`) reports `$0.00`/`0 tokens` for unrecognized model ids and for backends (like Ollama) that don't return `usage` in streamed responses — this is expected, not a bug.

## Commands

Type `/` to see live autocomplete suggestions (Ink UI: arrow keys to select, Tab to complete; `readline` fallback: Tab-completion).

- `/help` — list all commands with descriptions
- `/cost` — token usage and estimated cost for the session
- `/clear` — clear the conversation history (same session id)
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
- `mcp.json` — `{ "servers": [{ "name": "...", "transport": "stdio", "command": "...", "args": [...] }] }`
- `plugins/<name>/index.js` — exports `registerTools(registry)` and/or `registerCommands(commands)`
- `skills/*.md` — frontmatter (`name`, `description`) + body; the full body is loaded on demand via the `read_skill` tool

## Tests

```bash
npm run typecheck
npm test
```

Includes a real end-to-end test that spawns a fixture MCP server over stdio (`test/mcp/client-manager.test.ts`).
