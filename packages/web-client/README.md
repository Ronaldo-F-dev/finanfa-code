# @finanfa/web-client

The browser-based chat UI for finanfa-code — a React + Vite single-page
app served by [`@finanfa/web-server`](../web-server) and talking to it
over WebSocket. The browser can't run [`@finanfa/core`](../core) directly
(no `fs`/`child_process` access), so this package is a pure frontend: all
agent state (sessions, tools, permissions, memory) lives server-side and
is streamed down over the socket.

## Structure

```
src/
  App.tsx                  top-level shell (chat view, projects list, project detail)
  main.tsx                 entry point — mounts App inside LanguageProvider
  urlState.ts              pure helpers for view/project/session state <-> URL query string
  hooks/useAgentSocket.ts   WebSocket client: session lifecycle, streaming messages, permissions, tools, MCP, todos
  i18n/
    LanguageContext.tsx     language provider/consumer
    dictionaries.ts         flat key -> string tables (currently en, fr)
  components/               Sidebar, ChatMessage, ModelPicker, PermissionModal,
                             McpPanel, MemoryPanel, ToolsPanel, TodoPanel, etc.
test/
  urlState.test.ts          vitest unit tests for urlState.ts
```

`i18n/dictionaries.ts` intentionally only covers this package's own
static UI chrome (buttons, labels, titles) — server-originated text
(effort-tier descriptions, permission prompts, memory/skill content,
model names, provider error messages) is deliberately left untranslated.

## Connecting to web-server

`useAgentSocket` opens `wss://<host>/ws` (or `ws://` over plain HTTP) on
the same host the page was served from — no separate configured URL. In
dev mode, `vite.config.ts` proxies `/ws` and `/api` to
`http://localhost:4600`, which is where `@finanfa/web-server` listens by
default, so the two run as separate processes locally but look same-origin
to the browser.

## Running

Dev server (Vite, with the proxy above — run `@finanfa/web-server`
separately on port 4600):

```bash
npm run dev -w @finanfa/web-client
```

Production build (outputs to `dist/`, which `web-server` serves as static
files):

```bash
npm run build -w @finanfa/web-client
```

Both are also available as root-level scripts: `npm run dev:web-client`
and `npm run build:web-client`.

## Tests

```bash
npx vitest run --dir packages/web-client
```

Currently only `test/urlState.test.ts` (pure functions, no DOM/jsdom
needed) — no component/hook tests yet.
