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

## Folder trust

A project is untrusted the first time it's opened — you're asked once
whether to trust its `.finanfa-code/settings.json` (permission
rules/hooks) and `plugins/` (arbitrary imported JS). Declining ignores
both for that run.
