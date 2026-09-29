# Editor integration (ACP)

`finanfa --acp` runs as an [Agent Client Protocol](https://agentclientprotocol.com/)
agent over stdio — the same tools/permissions/hooks as every other entry
point, driven directly from an ACP-aware editor instead of a terminal or
browser.

## Zed

Add a custom agent server in Zed's settings (`~/.config/zed/settings.json`,
or via the Settings UI):

```json
{
  "agent_servers": {
    "finanfa-code": {
      "type": "custom",
      "command": "finanfa",
      "args": ["--acp"]
    }
  }
}
```

Open Zed's Agent panel and select "finanfa-code" to start a thread. Each
Zed thread gets its own session; the working directory Zed reports for
that thread is used as-is.

## Scope

The core lifecycle (init, session, prompt streaming, tool calls,
permission requests, cancel) is real and tested. The richer ACP surfaces
are implemented too:

- **Session modes** (`session/set_mode`) — mapped onto finanfa-code's own
  `/plan` slash command: a single `default`/`plan` toggle, not separate
  ACP-only state. Plan mode can also turn itself off from the agent's own
  side (calling `exit_plan_mode` once a plan is approved), not just an
  explicit `session/set_mode` request — either way, a
  `current_mode_update` notification follows so the client's mode UI
  stays in sync.
- **Per-session MCP servers** — `session/new`/`session/load`'s
  `mcpServers` param is connected on top of the project's own
  `.finanfa-code/mcp.json` (additive; a name collision favors the
  client-supplied server). `http`/`sse` transports are supported;
  `stdio` servers are connected by command/args. ACP-transport MCP
  servers (`mcp/connect` over the same JSON-RPC channel) aren't
  supported yet.
- **`loadSession` replay** — `initialize` advertises
  `agentCapabilities.loadSession: true`, and `session/load` replays a
  resumed session's real persisted history (user/assistant messages,
  tool calls and results) as `session/update` notifications, so a
  client's UI can redisplay a prior conversation exactly as it looked
  live.
- **Client filesystem/terminal methods** — when the connecting client's
  `clientCapabilities` advertise `fs.readTextFile`/`fs.writeTextFile`/
  `terminal` at `initialize`, `read_file`/`write_file`/`bash` are routed
  through the client's own RPCs for that session instead of touching
  this process's filesystem/subprocesses directly. A client that doesn't
  advertise one of these falls back to the tool's normal (direct)
  behavior for it.

Extension methods this SDK also exposes beyond the ACP spec itself
(`providers/*`, `nes/*`, `document/*`, `session/fork`, `session/list`,
`session/resume`, `session/close`, config options) aren't implemented —
no client this project has been driven by negotiates them yet.
