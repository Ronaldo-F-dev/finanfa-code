# @finanfa/cli

The terminal UI and `finanfa` CLI binary. Built on [Ink](https://github.com/vadimdemedes/ink)
(React for terminals), consuming [`@finanfa/core`](../core) as its engine.

For end-user usage — flags, slash commands, provider setup — see the
[root README](../../README.md). For ACP/editor integration details, see
[docs/editor-integration.md](../../docs/editor-integration.md).

## Structure

- `bin/finanfa.ts` — the published binary entry point, delegates to `src/cli.ts`.
- `src/cli.ts` — argument parsing (commander) and startup logic.
- `src/ui/ink/` — the Ink terminal UI (`App.tsx`, `store.ts`, `components/`).
- `src/ui/readline-adapter.ts`, `src/ui/markdown.ts` — non-Ink UI plumbing (plain
  readline input, markdown rendering for terminal output).
- `src/acp.ts`, `src/acp-client-tools.ts` — the ACP (Agent Client Protocol) agent
  implementation, for editors like Zed that drive finanfa-code directly over stdio
  instead of through the terminal UI. Triggered by the `--acp` flag, handled in
  `cli.ts` before any banner/UI setup.

## Dev

```bash
npm run dev
```

Runs `tsx bin/finanfa.ts` directly, no build step.

## Build

```bash
npm run build
```

Runs `tsup` to produce the distributable at `dist/finanfa.js` (the `bin` entry
in `package.json`).

## Tests

Tests live in `packages/cli/test/` (CLI argument handling, ACP, bundling, and
the Ink UI components). There's no per-package test script; run them from the
repo root:

```bash
npx vitest run packages/cli/test
```
