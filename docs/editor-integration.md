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
permission requests, cancel) is real and tested. Richer ACP surfaces
(session modes, per-session MCP servers, `loadSession` replay, client
filesystem/terminal methods) aren't implemented yet.
