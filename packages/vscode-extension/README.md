# @finanfa/vscode-extension

AI coding agent for VS Code — the same `@finanfa/core` engine as the CLI,
running in a chat sidebar (`finanfa-code` activity bar icon → "Chat" view,
`finanfa.chatView`).

## Structure

- `src/extension.ts` — activation entry point (`onView:finanfa.chatView`);
  registers the webview view provider.
- `src/webview/chat-view-provider.ts` — owns the webview, wires it to the
  engine.
- `src/engine/` — `session-runner.ts`, `message-handler.ts`, `history.ts`,
  `vscode-ui-adapter.ts`: run `@finanfa/core` sessions inside the extension
  host and adapt its UI callbacks to VS Code.
- `webview-ui/` — a separate React app (`@finanfa/vscode-webview-ui`,
  its own `package.json`/`tsconfig.json`, built with Vite) that renders the
  chat UI inside the webview.

The extension host and `webview-ui` communicate over the standard VS Code
webview message-passing API: the webview calls `vscode.postMessage(...)`
(e.g. `user_message`, `permission_response`, `interrupt`, `set_model`) and
the extension host listens via `webviewView.webview.onDidReceiveMessage`;
the host pushes updates back with `webviewView.webview.postMessage(...)`.

## Build

```bash
npm run build --workspace=@finanfa/vscode-extension
```

This first builds `webview-ui` (`vite build`), then bundles
`src/extension.ts` with esbuild into `dist/extension.cjs` (CJS, targeting
`node18`, per `esbuild.config.mjs`). For iterating on the extension host
only:

```bash
npm run watch --workspace=@finanfa/vscode-extension
```

(runs `esbuild.config.mjs --watch`; re-run the `webview-ui` build
separately when you change the React app).

`@finanfa/core` is bundled in (it's workspace TypeScript source, not a
published package); real npm dependencies with native/optional
sub-dependencies (`sharp`, `playwright-core`, `serialport`, etc.) are kept
external — see the comments in `esbuild.config.mjs` for why.

## Running it locally

There's no `.vscode/launch.json` in this package, so use VS Code's
generic extension debugging: open this repo in VS Code, run `npm run
build --workspace=@finanfa/vscode-extension` (or `watch`) so `dist/` is
present, then use "Run Extension" (Extension Development Host) from VS
Code's Run and Debug view with this package's directory as the extension
root. The chat view appears under the `finanfa-code` icon in the activity
bar.

## Packaging

`npm run package --workspace=@finanfa/vscode-extension` runs `vsce
package --no-dependencies` to produce a `.vsix`. `.vscodeignore` excludes
`src/`, `webview-ui/`, `test/`, and `node_modules/` from the package —
only `dist/`, `media/`, and `package.json` ship.

## Tests

```bash
npx vitest run packages/vscode-extension
```

`test/bundle.test.ts` and `test/engine/*.test.ts` cover the esbuild
bundle and the engine adapters (`history`, `message-handler`,
`session-runner`, `vscode-ui-adapter`). These run as part of the repo-wide
`npm test` (vitest) too.
