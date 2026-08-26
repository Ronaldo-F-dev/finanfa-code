# finanfa-code

A from-scratch AI coding agent CLI, built in TypeScript on the Anthropic Messages API.

## Status

Phase 1 (core agent loop): plain-text streaming conversation, session persistence, resume, cost tracking. No tools yet.

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

## Commands

- `/cost` — show token usage and estimated cost for the session
- `/exit` — quit

## Roadmap

1. Core agent loop (this phase)
2. Built-in tools (read/write/edit files, glob, grep, bash) + permission model
3. Rich terminal UI (Ink)
4. Extensibility: MCP client, plugins, skills
