# @finanfa/core

finanfa-code's engine: agent loop, tools, providers, sessions,
permissions, and MCP client — consumed by the CLI (`finanfa-code`) and
the web server, and eventually a standalone web frontend. This package
isn't published or meant to be used standalone; it's a private
workspace dependency.

## Table of contents

- [Structure](#structure)
- [Tools](#tools)
- [Providers](#providers)
- [Permissions](#permissions)
- [Tests](#tests)
- [Contributing a new tool](#contributing-a-new-tool)

## Structure

```
src/
  agents/      Subagent types (loader for custom agentType values the task tool can delegate to)
  browser/     Chromium automation (playwright-core) backing the browser tool
  channels/    Inbound chat channel adapters (Slack, Telegram, Matrix, LINE, Feishu, Teams, Discord, WhatsApp, SMS, Voice)
  commands/    Slash-command implementations (/help, /cost, /compact, /undo, /rewind, ...)
  core/        Agent loop, session persistence, config, permissions/trust plumbing, RAG (core/rag/), embeddings, tool-search
  gpio/        GPIO device access for embedded/IoT tools
  hooks/       PreToolUse/other lifecycle hook execution
  mcp/         MCP client (connects to external MCP servers)
  memory/      Project memory notes storage/search
  observability/  OpenTelemetry tracing setup
  permissions/ Risk classification and the allow/ask/deny decision engine
  plugins/     Plugin SDK loader
  providers/   One file per LLM backend (Anthropic, Bedrock, Vertex, Azure, Cohere, Gemini, GitHub Copilot, OpenAI-compatible)
  serial/      Serial port access for embedded/IoT tools
  skills/      Skill loading (packaged instruction sets)
  tools/builtin/  The builtin tool catalog (see below)
  ui/          UI adapter interface consumed by the terminal/web frontends
  util/        Shared low-level helpers (subprocess execution, sandboxing, image handling, retry, truncation)
```

`core/` is the densest area: `loop.ts` (the agent turn loop), `session.ts`
(persistence), `config.ts` (`.finanfa-code/config.json` resolution),
`permissions`-adjacent trust/classifier plumbing, `tool-search.ts` (the
per-turn tool subset selection every provider uses), and `core/rag/` for
project document indexing/search.

## Tools

`src/tools/builtin/` currently registers **188 tools** (via
`registerBuiltins`/`registerStatefulBuiltins` in
[`index.ts`](src/tools/builtin/index.ts) — that's the single place that
shows the full builtin tool surface, including tools gated behind
`isCommandAvailable(...)` checks, e.g. `nmap`/`msfconsole`/`nginx`).
Real categories present: files/search (`read-file`, `edit-file`,
`multi-edit-file`, `glob`, `grep`), git, shell/process (`bash`,
`background-process`, `tmux`), browser automation, documents/media
(PDF/spreadsheet/image/video/OCR/TTS conversion), DevOps (Docker,
Kubernetes, Terraform, ArgoCD, CI/CD generation, monitoring stacks,
remote deploy/rollback), security scanning (`tools/builtin/security/` —
~55 files covering recon, injection classes, WAF/TLS/header checks,
wifi/bluetooth capture, secops audits), IoT/embedded (GPIO, serial,
MQTT, CoAP, firmware flashing, Home Assistant), messaging channels
(Slack/Telegram/Matrix/LINE/Feishu/Teams/Discord/WhatsApp/SMS/email),
and agent-delegation tools (`task`, `delegate-agent`, workflows). See
[docs/tools.md](../../docs/tools.md) for the full catalog by category
and [docs/tool-search.md](../../docs/tool-search.md) for why only a
handful of these schemas are sent to the model per turn instead of all
188.

Most DevOps/security/IoT tools follow a "wrap the real CLI, don't
reinvent it" convention — e.g. [`containers.ts`](src/tools/builtin/containers.ts)
wraps `docker`/`kubectl` via [`generic-cli-wrapper.ts`](src/tools/builtin/generic-cli-wrapper.ts)
rather than reimplementing the Docker Engine or Kubernetes API client.

## Providers

Every provider implements the same interface (`LlmProvider` in
[`core/types.ts`](src/core/types.ts)) and speaks the neutral
`NeutralToolCall`/message shape the agent loop and session storage
operate on, so swapping models doesn't touch either. Each backend
(`providers/anthropic-provider.ts`, `amazon-bedrock-provider.ts`,
`google-vertex-provider.ts`, `azure-openai-provider.ts`,
`cohere-provider.ts`, `gemini-provider.ts`, `github-copilot-provider.ts`,
`openai-compatible-provider.ts`) translates that neutral shape to/from
its own wire format — including quirks like Anthropic's extended-thinking
blocks needing to be replayed verbatim on the next turn. See
[docs/providers.md](../../docs/providers.md) for the full list, setup,
and environment variables.

## Permissions

Every `ToolDefinition` declares a `riskLevel` of `safe`, `ask`, or
`dangerous` (`core/types.ts`). `permissions/classifier.ts` and
`permissions/manager.ts` combine that with `settings.json` rules,
`--yolo`, the session allowlist, and any `PreToolUse` hook to decide
whether a call runs, prompts, or is denied. See
[docs/security.md](../../docs/security.md) (risk levels, audit trail,
sandbox) and [docs/configuration.md](../../docs/configuration.md#permissions-and-hooks-settingsjson)
(the `defaultForRiskLevel` settings shape) for the full picture.

## Tests

From the repo root:

```bash
npx vitest run packages/core/test
```

(`npm test` at the root runs the whole monorepo's vitest suite, which
includes this package's tests plus fixture MCP servers, real Chromium
automation, and real subprocess/network tests for the IoT/DevOps
wrappers.)

## Contributing a new tool

A tool is a `ToolDefinition` object (`core/types.ts`):

```ts
export interface ToolDefinition<TInput = any> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  riskLevel: ToolRiskLevel; // "safe" | "ask" | "dangerous"
  handler: (input: TInput, ctx: ToolContext) => Promise<ToolResult>;
  riskKey?: (input: TInput) => string;
  describeCall?: (input: TInput) => string;
  preview?: (input: TInput, ctx: ToolContext) => Promise<string>;
}
```

Add the file under `src/tools/builtin/` (or `security/` for a security
scanner), then register it in
[`src/tools/builtin/index.ts`](src/tools/builtin/index.ts) —
`registerBuiltins` for stateless tools, `registerStatefulBuiltins` for
tools that need a shared long-lived manager (browser, background
processes, serial ports, etc.). If the tool is a thin wrapper around an
external CLI, use [`generic-cli-wrapper.ts`](src/tools/builtin/generic-cli-wrapper.ts)
(see `containers.ts` for a working example) instead of reimplementing
that program's API client.
