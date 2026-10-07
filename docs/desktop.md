# Desktop app

A native window around the web UI. Opening it starts finanfa's web server in the background
(on a free port, loopback only) and shows the UI in a window; quitting stops the server and
everything it started. It is the same agent, tools and config as the terminal and browser
UIs — this is another way in, not another product.

> Status: runs from a source checkout, and installers for macOS, Windows and Linux are built by a workflow
> (see "Installers"). They are not signed yet, and there is no auto-update.

## Run it

```bash
npm install
npm run dev:desktop      # builds the web client, then opens the app
```

The first launch downloads the Electron binary (about 100 MB). On macOS it also builds, once, a copy of
Electron named **Finanfa** with the brand icon (`packages/desktop/.dev/`, an APFS clone: instant and no extra
disk) and runs the app from it — otherwise macOS shows "Electron" and Electron's own icon in the Dock, the menu
bar and Cmd-Tab, because those come from the app bundle, not from the running code. A packaged build gets this
for free; this only exists for `npm run dev:desktop`.

The app opens straight into a working state: the agent works in **`~/Finanfa`**, created on first launch. That
folder is the agent's "open project" — where its file tools read and write and where its commands run (the same
way an editor opens a folder). Change it any time with **File → Change workspace…**, or pass
`--workspace=<dir>`. The window title shows the folder in use.

| `Cmd/Ctrl+Shift+Space` | show or hide the window from anywhere |
| `Cmd/Ctrl+Shift+O` | change workspace |
| **File → Show workspace in Finder** | open the agent's folder |
| **File → Server log…** | the server's recent output (useful if something fails to start) |

Provider keys and config come from the same places as everywhere else (`~/.finanfa-code/config.json`,
`FINANFA_*` / `ANTHROPIC_API_KEY` environment variables).

## How it is put together

```
Electron main process (packages/desktop)
 ├─ spawns  the web server  (Electron's own Node, ELECTRON_RUN_AS_NODE; PORT=0, 127.0.0.1)
 └─ opens   a BrowserWindow → http://127.0.0.1:<port>   (sandboxed, no Node, one origin only)
```

- **A per-launch token.** The web UI sends plain requests with no auth of its own, so the window
  adds `Authorization: Bearer <random 256-bit token>` to every request it makes to *its* server
  (REST, images, SSE and the WebSocket handshake) and the server runs with gateway auth on. A
  scan of local ports, another local user, or a web page open in your browser gets `401`.
  The token exists only in memory, for that launch.
- **One origin.** The window never navigates away from its server. Links in an agent's reply open in
  your real browser (`http`, `https`, `mailto` only); everything else is dropped. The page is granted no
  OS permissions (camera, microphone, location…) except copying to the clipboard.
- **No orphans.** Quitting stops the server's whole process group. If the app itself crashes or is
  force-quit, the server notices (`FINANFA_PARENT_PID`) and exits within a couple of seconds.
- **If the server dies**, a dialog shows its last output and offers Restart or Quit.

## Installers

The workflow **Desktop installers** (`.github/workflows/desktop-installers.yml`) builds, each on its own system:

| System | Files |
| --- | --- |
| macOS, Apple silicon and Intel | `.dmg` and `.zip` |
| Windows | an installer (`.exe`) |
| Linux | an `.AppImage` and a `.deb` |

Run it from the Actions tab, or push a tag such as `v0.1.0`: the tag also publishes a GitHub release with every file.
Each system builds its own because the server inside carries native packages (images, serial ports, PDF rendering)
that differ per system.

To build one here, on the system you are on:

```bash
npm run pack -w @finanfa/desktop      # an unpacked app in packages/desktop/release (quick to test)
npm run dist -w @finanfa/desktop      # the installers for this system
```

How it is put together: `scripts/bundle-server.mjs` bundles the web server into one file (`server.mjs`) and copies the
few packages that cannot be bundled (`sharp`, `serialport`, `@napi-rs/canvas`, `playwright-core`, `web-tree-sitter` and
the grammars the repo map uses) next to it; `electron-builder.yml` packs the window, the server and the built web
client; `scripts/after-pack.cjs` puts the native packages into the app, because electron-builder never copies a
`node_modules` folder into resources. The installed app starts the bundled server the same way a source checkout
starts the TypeScript one.

- **Signing.** Without a certificate the macOS app is signed ad hoc (so Apple silicon does not call it damaged) and
  the first launch needs a confirmation: right-click the app, then Open. Windows shows a SmartScreen notice. To sign,
  add the usual electron-builder secrets to the repository (`CSC_LINK`, `CSC_KEY_PASSWORD`, and for notarization
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`); the build uses them as soon as they exist and never
  uses a certificate it finds on its own in a keychain.
- **Left out of the installers:** the local embedding model (`@huggingface/transformers`, about 400 MB), which the
  feature loads on demand and reports as missing.

## Verify it

```bash
npm run smoke:desktop
```

Starts the real app with a hidden window and checks that an unauthenticated request gets `401`, the
UI renders, and an authenticated REST call and WebSocket both succeed, then exits `0` (or `1`).
To keep it away from your own config, run it with `HOME=$(mktemp -d)`. On a headless Linux box it needs a
display (`xvfb-run`). Unit tests: `npx vitest run packages/desktop`.

## Troubleshooting

- **The app opens in the wrong folder.** The choice is remembered in
  `~/Library/Application Support/finanfa-desktop/settings.json`. Change it with **File → Change workspace…**
  (`Cmd+Shift+O`), or delete that file to go back to `~/Finanfa`. A remembered folder inside the system's
  temporary directory is ignored.
- **The Dock shows "Electron" or Electron's icon.** You are running the stock binary; use `npm run dev:desktop`
  (it runs the "Finanfa" bundle). Delete `packages/desktop/.dev` to force it to be rebuilt.
- **`Failed to create directory … Shared Dictionary/cache` / `Unable to create cache` in the terminal.** These come
  from Chromium's on-disk HTTP cache for the window, not from finanfa, and the app works without it. If a cache
  folder was left half-written (for example by an earlier run that was interrupted or ran in a restricted
  environment), delete `~/Library/Application Support/finanfa-desktop/Partitions` — it only holds that cache and the
  theme/language choice; the workspace and window position are in `settings.json`, outside it.
- `npm run smoke:desktop` never writes your settings; pass `--user-data-dir=<scratch dir>` to run it fully apart
  from your real data.

## What is not done

- **Signed installers and auto-update.** The installers exist but are unsigned (see "Installers"); updating means
  downloading the next release by hand.
- **More app-specific UI** — approval toggles per category and per-feature model choice. The window shows
  the web UI, which already has a diff view when you approve a file edit and a "Restore" button to go back to
  before any message of the current conversation (undoing the file edits made since).
- Notifications, a tray icon, "start at login".
