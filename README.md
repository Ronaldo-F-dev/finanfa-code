# finanfa-code

**Real tools, real actions, any machine. Not a chatbot — an operator.**

A from-scratch AI coding agent, in TypeScript, with a terminal UI, a
browser UI, a VS Code extension, and editor integration via ACP. 90+
builtin tools (files, shell, git, browser, documents, IoT, DevOps,
security scanning, and more), a pluggable LLM backend (Anthropic, Azure
OpenAI, Gemini, Cohere, GitHub Copilot, Amazon Bedrock, Google Vertex AI,
or any local/remote server speaking the OpenAI chat-completions format),
MCP support, permissions, hooks, skills, memory, and 10 inbound chat
channels.

Requires **Node.js 22.5.0+**.

## Sponsors

**phpnitro**

## Table of contents

- [Quickstart](#quickstart)
- [Running](#running)
- [CLI flags](#cli-flags)
- [Commands](#commands)
- [Documentation](#documentation)
- [Tests](#tests)

## Quickstart

### 1. Clone and install

```bash
git clone https://github.com/Ronaldo-F-dev/finanfa-code.git
cd finanfa-code
npm install
```

### 2. Configure a model

Pick **one** of these to get started. See [docs/providers.md](docs/providers.md)
for the full list (Azure OpenAI, Gemini, Cohere, GitHub Copilot, Amazon
Bedrock, Google Vertex AI, remote OpenRouter/Poolside, and more), including
every option's exact environment variables.

**Anthropic (fastest to start with):**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**A local model (no API key, nothing leaves your machine)** — works with
[Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai),
llama.cpp, vLLM, or Docker Model Runner:

```bash
ollama pull llama3.1:8b   # any tool-calling-capable model

export FINANFA_PROVIDER=openai-compatible
export FINANFA_BASE_URL=http://localhost:11434/v1
export FINANFA_MODEL=llama3.1:8b
```

A running local server on a well-known port (Ollama, LM Studio,
llama.cpp, vLLM, Docker Model Runner) is auto-detected — the web UI's
model picker lists what's actually available with no configuration at
all. A local/small model also gets [Tool Search](docs/tool-search.md)
automatically, so a handful of tools are sent per turn instead of all
90+.

**A remote OpenAI-compatible endpoint** (OpenRouter, Poolside, ...):

```bash
export FINANFA_PROVIDER=openai-compatible
export FINANFA_BASE_URL=https://openrouter.ai/api/v1
export FINANFA_MODEL=anthropic/claude-sonnet-5
export FINANFA_API_KEY=sk-or-...
```

**Docker** (runs the whole project in a container, no local Node.js
install needed) — see [docs/deployment.md](docs/deployment.md) for the
full walkthrough, Fly.io/Render.com hosting, and multi-user auth:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build
# -> http://localhost:4600
```

Once set, save it so you don't have to export it again:

```
/config set provider openai-compatible
/config set baseUrl http://localhost:11434/v1
/config set model llama3.1:8b
```

Saved to `~/.finanfa-code/config.json` (global) or
`.finanfa-code/config.json` (project-local, overrides global).

### 3. Run

```bash
npm run dev
```

That's it — you're in the terminal UI. Type `/help` for commands, or
just start describing what you want done.

## Running

### Terminal (default)

```bash
npm run dev
```

### Browser

Two processes, in two terminals:

```bash
npm run dev:web-server   # terminal 1 — API/WebSocket server on http://localhost:4600
npm run dev:web-client   # terminal 2 — Vite dev server, proxies /api and /ws to the server above
```

Open the URL `dev:web-client` prints (`http://localhost:5173` by
default). Same agent, same tools/config as the terminal UI — a chat UI
with sessions, projects, MCP/skills/memory panels, and model switching.

By default the web server operates on the directory it was started
from; point it elsewhere with `FINANFA_WEB_CWD=/path/to/project npm run
dev:web-server`. For a one-off production build instead of the dev
server: `npm run build:web-client`, then `npm run dev:web-server` serves
the built client directly.

### Docker, self-hosting, and multi-user access

See [docs/deployment.md](docs/deployment.md).

## CLI flags

| Flag | Effect |
|---|---|
| `-r, --resume <id>` / `-c, --continue` | Resume a saved session |
| `-m, --model <model>` | Model to use |
| `--yolo` | Auto-approve every tool call (no prompts) |
| `--non-interactive` | Never prompt; auto-deny anything not pre-allowed |
| `--ui <ink\|readline>` | Terminal UI mode |
| `-p, --prompt <text>` | Run one prompt non-interactively and exit — no REPL |
| `--cwd <path>` | Project directory to operate in (defaults to the current directory) |
| `--max-turns <n>` | With `--prompt`: auto-continue past the step-limit guard up to this many times. Default `5`; `1` disables it |
| `--acp` | Run as an [Agent Client Protocol](https://agentclientprotocol.com/) agent — see [docs/editor-integration.md](docs/editor-integration.md) |

Non-interactive one-shot example:

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
| `/rewind [n]` | Restore conversation + files to a past checkpoint |
| `/plan [on\|off]` | Plan mode — only read-only tools run until a plan is proposed and approved |
| `/tools [list]` / `/tools enable\|disable <name>` | List/toggle registered tools |
| `/todos` | Show the current task checklist |
| `/memory` | List saved project memory notes |
| `/goal [text]` | Set/clear a standing session goal |
| `/sessions` / `/session <id>` | List / switch sessions |
| `/mcp ...` | Manage MCP servers — see [docs/mcp.md](docs/mcp.md) |
| `/config ...` | Persistent provider defaults — see [docs/providers.md](docs/providers.md) |
| `/exit` | Quit |

Ctrl+C persists the session and closes connections cleanly before exit.

## Documentation

| Doc | Covers |
|---|---|
| [docs/providers.md](docs/providers.md) | Every model provider (local and remote), persistent config, vision routing |
| [docs/tool-search.md](docs/tool-search.md) | How a small/local model avoids paying for all 90+ tool schemas every turn |
| [docs/tools.md](docs/tools.md) | The full builtin tool catalog by category |
| [docs/channels.md](docs/channels.md) | Slack, Telegram, Matrix, LINE, Feishu, Microsoft Teams, Discord, WhatsApp, SMS, Voice |
| [docs/mcp.md](docs/mcp.md) | Connecting external MCP servers |
| [docs/configuration.md](docs/configuration.md) | `.finanfa-code/` project config, permissions/hooks, memory, bundles ("Claws") |
| [docs/plugins.md](docs/plugins.md) | The plugin SDK contract |
| [docs/deployment.md](docs/deployment.md) | Docker, Fly.io/Render.com, multi-user access (Gateway) |
| [docs/editor-integration.md](docs/editor-integration.md) | ACP / Zed |
| [docs/security.md](docs/security.md) | Runtime security features (permissions, audit trail, sandbox) |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting policy |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |

## Tests

```bash
npm run typecheck
npm test
```

Real end-to-end coverage throughout: fixture MCP servers (stdio +
Streamable HTTP), real Chromium automation (`npx playwright-core install
chromium` first), real subprocess/network tests for the IoT and DevOps
tool wrappers, and a real WebSocket/subprocess harness for the web
server.
