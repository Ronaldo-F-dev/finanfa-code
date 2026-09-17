# Project configuration

Everything project-specific lives under `.finanfa-code/` in the project
root, plus two files at the root itself. Skills, memory, commands, and
agent types each also have a global counterpart under `~/.finanfa-code/`
(merged with the project-local ones; project wins on a name collision).

| Path | Purpose |
|---|---|
| `settings.json` | Permission rules and hooks — see below |
| `commands/*.md` | Custom `/name` slash commands |
| `agents/*.md` | Named subagent types for the `task` tool |
| `skills/*.md` | Loaded on demand via `read_skill` |
| `memory/*.md` | Durable notes the agent writes via `write_memory` — see [Memory](#memory) |
| `mcp.json` | MCP server list — see [mcp.md](mcp.md) |
| `plugins/<name>/index.js` | Arbitrary tool/command registration — see [plugins.md](plugins.md) |
| `instructions/*.md` | Path-scoped project instructions |
| `finanfa.md` (project root) | Free-form project instructions (the `CLAUDE.md`/`AGENTS.md` equivalent) |
| `finanfa-design.md` (project root) | Design contract for `create_artifact` |

## Permissions and hooks (`settings.json`)

```json
{
  "rules": [
    { "tool": "bash", "keyPrefix": "git", "cwdPrefix": "packages/web-client", "decision": "allow" }
  ],
  "defaultForRiskLevel": { "safe": "allow", "ask": "prompt", "dangerous": "prompt" },
  "hooks": {
    "PreToolUse": [{ "command": "..." }]
  }
}
```

`tool: "*"` matches every tool. `keyPrefix`/`cwdPrefix` are each optional
— both must match when both are given. `cwdPrefix` scopes a rule to part
of a monorepo, e.g. auto-allowing `bash` inside one already-reviewed
directory without loosening it everywhere else. `hooks` runs shell
commands on `PreToolUse`/`PostToolUse`/`UserPromptSubmit`, same
convention as Claude Code.

A project is untrusted by default the first time you open it — you're
asked once whether to trust its `settings.json`. Declining ignores its
rules/hooks/plugins for that run.

## Path-scoped instructions

For conventions that only apply to one part of a monorepo instead of
competing for attention in one `finanfa.md`:

```markdown
---
description: React conventions
applyTo: "packages/web-client/**/*.tsx"
---

Function components only, never class components. Co-locate a component's styles in the same file.
```

`applyTo` is a glob or list of globs (omit for a note that's always
relevant). Every instructions file is included in the system prompt up
front, labeled with its own globs — the model is expected to apply each
one only when actually working on a matching path.

## Agent types

A file under `agents/<name>.md` defines a named subagent type for the
`task` tool — its own system prompt, and optionally a restricted `tools`
allowlist. Select it via `task`'s `agentType` input.

## Memory

`write_memory`/`delete_memory` save durable, freeform notes (user
preferences, feedback on how to approach work, project decisions, or
pointers to external systems) as markdown files under `memory/`. Each
note records real provenance: when it was first saved, when it was last
updated, and which session actually originated it.

`search_memories` finds a note by meaning, not just its exact name —
keyword mode (default, no API call) or an optional semantic mode over
OpenAI embeddings (needs `OPENAI_API_KEY`, cached by content hash so an
unchanged note never costs a repeat API call). `find_duplicate_memories`
scans the whole store for likely near-duplicates to merge.

## Bundles ("Claws")

`export_bundle`/`install_bundle` package everything above (permission
rules/hooks, MCP servers, memory, skills, commands, agent types,
path-scoped instructions, `finanfa.md`/`finanfa-design.md`) into one
shareable, versioned JSON bundle — a checkpoint of a project's whole
configuration, or a way to hand someone else an identical setup.

`install_bundle` snapshots the exact prior content of every file it's
about to overwrite first (`list_bundle_snapshots`/`rollback_bundle` undo
it exactly). **A bundle's `settings.json` can carry hooks — arbitrary
shell commands that run automatically once the project is trusted** — so
`install_bundle` is `riskLevel: dangerous`; only install one from a
source you actually trust.

Every bundle is signed (Ed25519, a stable per-machine identity generated
automatically the first time you export one). `install_bundle` verifies
the signature and reports whether this machine has seen that publisher's
key before, plus whether this is a new/upgrade/downgrade/reinstall
relative to whatever version was last installed here. A valid signature
only proves the content wasn't altered after signing — it says nothing
about whether that content is safe to install.

### Hosted registry

Beyond sharing the JSON directly, `publish_bundle_to_registry` /
`list_registry_bundles` / `list_registry_bundle_versions` /
`install_bundle_from_registry` publish to and install from a real hosted
registry — any GitHub repository you (or your org) already control
(public for open sharing, private for internal), using GitHub's own
Contents API as the storage backend (`bundles/<name>/<version>.json`,
committed like any other file). Published versions are immutable — bump
the version to publish an update. Requires `CLAWS_REGISTRY_TOKEN` (a
GitHub personal access token) to publish; listing/installing from a
public repo works without one.
