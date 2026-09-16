# Contributing

Thanks for considering contributing to finanfa-code. This is a young,
solo-maintained project (see [SECURITY.md](SECURITY.md)), so keep pull
requests focused — small, reviewable changes get merged faster than
large ones.

## Project layout

An npm workspaces monorepo:

- `packages/core` — the agent loop, ~90 builtin tools, LLM providers,
  permissions, MCP, hooks, skills, memory, plugins.
- `packages/cli` — the terminal UI (Ink).
- `packages/web-server` — the API/WebSocket server for the browser UI.
- `packages/web-client` — the React/Vite browser chat UI.
- `packages/vscode-extension` — the VS Code extension.

See the [README](README.md) for how to run each of these, and
[docs/plugins.md](docs/plugins.md) for the plugin contract if you're
adding a tool without touching core.

## Setup

```bash
npm install
```

Requires Node.js **22.5.0+** (CI runs the latest 22.x — see
`.github/workflows/ci.yml`).

## Before opening a PR

```bash
npm run typecheck
npm run lint
npm test
```

All three run in CI on every push/PR and must pass. A few real
end-to-end tests need local tools not every machine has (Chromium via
Playwright, `bwrap`, `tesseract`, `poppler-utils`, `ruff` via `uvx`,
...) — see `.github/workflows/ci.yml` for the exact list CI installs.
It's fine if a handful of those are red locally as long as the reason is
one of those missing tools, not a real failure; CI is the source of
truth.

## Code style

- No dedicated formatter/linter config beyond
  [`.oxlintrc.json`](.oxlintrc.json) (`npm run lint`) — match the style
  already in the file you're editing.
- Prefer small, focused commits — one logical change each — over one
  large commit bundling unrelated fixes. This makes review and, if
  needed, revert much easier.
- Comments should explain *why*, not *what* — the kind of thing that'd
  surprise a reader (a workaround, a non-obvious invariant, a past
  incident), not a restatement of the code.
- New behavior needs a test. This project leans heavily on real
  end-to-end tests (a real subprocess, a real temp git repo, a real
  local HTTP server) over mocks — see any `test/tools/*.test.ts` for the
  pattern, and follow it rather than introducing a new mocking style.

## Adding a tool

Prefer a [plugin](docs/plugins.md) (`.finanfa-code/plugins/`) over a
core change when possible — it ships without touching this repo at all.
A genuinely new *builtin* tool (one every user should get by default)
goes in `packages/core/src/tools/builtin/`, registered in
`packages/core/src/tools/builtin/index.ts`, with:

- An honest `riskLevel` (`"safe"` / `"ask"` / `"dangerous"`) — see
  [docs/plugins.md](docs/plugins.md#registertoolsregistry) for what each
  means. When in doubt, err toward `"ask"` or `"dangerous"`.
- A test under `packages/core/test/tools/`.

## Reporting bugs / requesting features

Open a GitHub issue. For anything security-sensitive, see
[SECURITY.md](SECURITY.md) instead — don't open a public issue for that.

## License

By contributing, you agree your contributions are licensed under this
project's [MIT license](LICENSE).
