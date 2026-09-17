# MCP (connecting external services)

```
/mcp add github -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server
/mcp add myservice --url https://mcp.example.com/mcp
```

Stdio servers run as a local process; `http`/`sse` servers go through an
OAuth flow on first use if required (`/mcp connect <name>`), with tokens
persisted under `~/.finanfa-code/mcp-auth/`. Any server implementing the
MCP spec works this way — GitHub, Notion, Gmail, Google Drive, Canva,
Supabase, and others have official or community servers.

With a GitHub MCP server connected, the agent can carry an issue through
to a PR end to end (read issue → branch → change → test → commit → push
→ open PR).

## Servers saved to `.finanfa-code/mcp.json`

```json
{ "servers": [{ "name": "github", "transport": "stdio", "command": "...", "args": [...] }] }
```

One entry per server (stdio or http/sse) — same shape `/mcp add` writes.

## Web UI one-click catalog

The web UI's Connectors page also offers a curated set of well-known
servers with a "Connect" button, no manual `/mcp add` needed:

- GitHub, Notion, Canva, Supabase, Gamma, Vercel
- Hostinger's `hostinger-api-mcp` package, as five separate servers —
  hosting, domains, DNS, billing, reach (each confirmed connecting end to
  end: 73/41/8/9/52 real tools respectively)
