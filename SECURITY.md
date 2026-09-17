# Security Policy

## Reporting a vulnerability

Please report security issues privately, not as a public GitHub issue:

- Email **awademeronaldoo@gmail.com**, or
- Use GitHub's [private vulnerability reporting](https://github.com/Ronaldo-F-dev/finanfa-code/security/advisories/new) ("Report a vulnerability" under the Security tab).

Include what you found, how to reproduce it, and its impact if you can.
There's no bug bounty — this is a solo-maintained project — but reports
are taken seriously and a fix will be worked on directly with you before
any public disclosure.

## Scope

This is an AI coding agent with 90+ builtin tools, several of which are
deliberately powerful by design: `bash`, `write_file`/`edit_file`,
`run_docker`/`run_kubectl`, browser automation, and a full suite of
offensive security-scanning tools (`security_scan_*`). Reports about
those tools behaving as documented (e.g. "the bash tool can run
arbitrary shell commands") aren't vulnerabilities — that's the intended,
permission-gated feature. What *is* in scope:

- A `"safe"`-tagged tool taking an action that should have required a
  permission prompt (an `"ask"`/`"dangerous"` risk level).
- Anything that bypasses the [permission system](docs/security.md#permission-system)
  or the [folder-trust gate](docs/plugins.md#trust) (e.g. an untrusted
  project's `.finanfa-code/settings.json` hooks or `plugins/` running
  without the trust prompt actually firing).
- Path traversal in `read_file`/`write_file`/`edit_file` outside the
  project root or the user's home directory (see [docs/tools.md](docs/tools.md)).
- Injection or SSRF in a tool that fetches URLs/runs queries on the
  user's behalf (`web_fetch`, `http_request`, `query_database`, ...)
  beyond what the user explicitly asked it to reach.
- Secrets (API keys, tokens from `~/.finanfa-code/config.json` or
  `mcp-auth/`) leaking into logs, session files, or a model prompt they
  shouldn't be part of.
- Supply-chain issues in this repo's own dependencies (see
  [Dependabot alerts](https://github.com/Ronaldo-F-dev/finanfa-code/security/dependabot),
  which are already monitored) or build/CI configuration.

## Supported versions

Pre-1.0, still under active development — only the latest commit on
`main` is supported. There are no maintained release branches yet.
