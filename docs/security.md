# Security

For the vulnerability-reporting policy, see [SECURITY.md](../SECURITY.md).
This page covers the runtime security features.

## System prompt guardrails

The system prompt permits authorized security testing, defensive
security, CTF, and security education, and declines destructive
techniques, DoS tooling, mass targeting, supply-chain compromise, or
detection evasion — several supported backends (local/free models) have
little built-in safety alignment of their own.

## Permission system

Every tool is gated by a risk level (`safe`/`ask`/`dangerous`) —
`settings.json` rules, `--yolo`, the session allowlist, and a
`PreToolUse` hook all factor into the final decision. See
[configuration.md](configuration.md#permissions-and-hooks-settingsjson).

## Audit trail

Every permission decision (allow/deny, and which of a `PreToolUse`
hook/`--yolo`/the session allowlist/a config rule/a direct user answer
decided it) is appended to a structured audit trail at
`~/.finanfa-code/audit/<date>.jsonl` — one JSON line per decision,
independent of both the OpenTelemetry trace file
(`~/.finanfa-code/traces/`, perf-only, never sees a denied call) and the
session transcript. Read it back with the `read_audit_log` tool, or
directly with `jq`/`grep` for a compliance review.

## Sandbox (`bash`)

An OS-level sandbox (bubblewrap on Linux — see `packages/core/src/util/sandbox.ts`)
can confine `bash`'s writes to its own cwd plus a curated set of dev-tool
cache directories, leaving the rest of the filesystem read-only. Off by
default; see `sandbox` in `.finanfa-code/settings.json`.

By default the sandboxed command shares the host network (blocking it would
break `npm install`, `git push` and `curl`). Set `"network": "deny"` to run it
in an empty network namespace — only loopback remains — when nothing it does
should reach the network. It is all-or-nothing: there is no per-domain
allow-list.

```json
{ "sandbox": { "mode": "workspace-write", "network": "deny" } }
```

Organization-wide guardrails (managed hooks, refusing `--yolo`, an allow-list
of plugin marketplaces) are set in the managed settings file — see
`docs/configuration.md`.

## Network exposure of the web server

The web server drives an agent with shell and file tools, so it is built to be
reachable only from the machine it runs on unless told otherwise.

- **Bind address**: `FINANFA_WEB_HOST`, default `127.0.0.1`. The Dockerfile, `fly.toml`,
  `render.yaml` and `docker-compose.yml` set `0.0.0.0` inside the container, which is
  required for them to be reachable at all — put gateway auth in front (see the README).
  Startup prints a warning when the server is bound beyond loopback with no auth.
- **WebSocket origin**: a browser lets any page open a WebSocket to any host, so the
  handshake's `Origin` must be this server's own or listed in `FINANFA_ALLOWED_ORIGINS`
  (comma-separated, e.g. `http://localhost:5173,https://app.example.com`). Clients that send
  no `Origin` (the CLI, scripts) are unaffected. The Vite dev server proxies with its own
  origin, which is the same host as its `Host` header, so `npm run dev:web-client` works as is.
- **DNS rebinding**: while bound to loopback, a request must address the server as
  `localhost`, `127.0.0.1` or `::1` (or a host from `FINANFA_ALLOWED_ORIGINS`, or the active
  tunnel's), else it gets `403`. Behind a reverse proxy on the same machine that forwards
  your public `Host`, add your origin to `FINANFA_ALLOWED_ORIGINS`.
- **`/api/workspace-file`** only serves files inside the project directory, with symlinks
  resolved, never `.env*`, `.git`, `.ssh`, `.finanfa-code` and similar credential locations.
- **Project ids** (`?project=`, `/api/projects/:id/...`) are `default` or a UUID; anything
  else is rejected, so an id can't walk out of the projects directory.
- **Channel credentials**: `/api/channels-config*` and `/api/tunnel-url` sit behind gateway
  auth like the rest of `/api`. A channel's inbound webhook keeps its own signature check.

Not covered: cross-site request forgery on the REST API relies on browsers refusing
cross-origin `application/json` requests without a CORS preflight, which this server never answers.

## Folder trust

A project is untrusted the first time it's opened — you're asked once
whether to trust its `.finanfa-code/settings.json` (permission
rules/hooks) and `plugins/` (arbitrary imported JS). Declining ignores
both for that run.
