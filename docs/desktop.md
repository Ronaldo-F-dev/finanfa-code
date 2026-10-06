# Desktop app

A native window around the web UI. Opening it starts finanfa's web server in the background
(on a free port, loopback only) and shows the UI in a window; quitting stops the server and
everything it started. It is the same agent, tools and config as the terminal and browser
UIs — this is another way in, not another product.

> Status: runs from a source checkout. **Installers (.dmg / .exe / .AppImage) are not built yet** —
> see "What is not done".

## Run it

```bash
npm install
npm run dev:desktop      # builds the web client, then opens the app
```

The first launch downloads the Electron binary (about 100 MB). It then asks which folder the
agent works in (change it later from **File → Change workspace…**, or pass `--workspace=<dir>`).

| | |
|---|---|
| `Cmd/Ctrl+Shift+Space` | show or hide the window from anywhere |
| `Cmd/Ctrl+Shift+O` | change workspace |
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

## Verify it

```bash
npm run smoke:desktop
```

Starts the real app with a hidden window and checks that an unauthenticated request gets `401`, the
UI renders, and an authenticated REST call and WebSocket both succeed, then exits `0` (or `1`).
To keep it away from your own config, run it with `HOME=$(mktemp -d)`. On a headless Linux box it needs a
display (`xvfb-run`). Unit tests: `npx vitest run packages/desktop`.

## What is not done

- **Installers and auto-update.** Packaging means bundling the server for Electron
  (native modules such as `sharp` and `serialport`, `playwright`, the built web client) and signing
  per platform; that is its own piece of work.
- **More app-specific UI** — approval toggles per category and per-feature model choice. The window shows
  the web UI, which already has a diff view when you approve a file edit and a "Restore" button to go back to
  before any message of the current conversation (undoing the file edits made since).
- Notifications, a tray icon, "start at login".
