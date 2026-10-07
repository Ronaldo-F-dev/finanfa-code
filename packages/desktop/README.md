# @finanfa/desktop

Desktop shell for finanfa-code: a small Electron app that starts the same
web server `npm run dev:web-server` runs, as a child process, and shows the
browser UI in a native window. No agent logic lives here — the window is a
second front-end for the server, like a browser tab.

## Running

From the repository root (after `npm install`):

```bash
npm run dev:desktop     # builds the web client + this app, then opens the window
npm run smoke:desktop   # same, but proves the chain and exits without showing anything
```

On macOS the app runs through a generated, renamed bundle so the Dock shows
"Finanfa" with the brand icon; elsewhere the stock Electron binary is used.
`npm run smoke:desktop` prints one `SMOKE OK`/`SMOKE FAILED` line with the
checks it ran: the page mounts, an authenticated REST call succeeds, the
WebSocket opens, and an unauthenticated REST call is refused.

`--workspace=<dir>` overrides the folder the agent works in for that run;
without it the app reuses the last one, or opens `~/Finanfa` (created on
first launch). **File → Change workspace…** switches it for good — the
server's working folder is fixed at start, so the app relaunches.

## Structure

```
src/
  main.ts               entry point — window, menu, single-instance lock, quit/shutdown wiring
  server-launch.ts      builds the child-process spawn (PORT=0, loopback, per-launch token) — Electron-free, unit-tested
  server-supervisor.ts  starts the server, watches for its "listening" line, kills its whole process tree on quit
  navigation.ts         what the window may load vs what opens in the real browser — pure, unit-tested
  settings.ts           window bounds + last workspace, defect-tolerantly loaded, atomically saved
  splash.ts             the inline "Starting Finanfa…" page
scripts/
  start.mjs             launches Electron (through the generated macOS bundle when applicable)
  dev-app.mjs           builds the renamed macOS dev bundle
  bundle-server.mjs     bundles the background server for installers, native packages copied next to it
  installers.mjs        runs electron-builder (signs only when a certificate is given)
  after-pack.cjs        electron-builder hook — copies the server's native packages into the app
```

## How the window is kept safe

- The server listens on `127.0.0.1` only, on an OS-assigned port, with a
  fresh random bearer token per launch (`FINANFA_WEB_USERS=desktop:<token>`)
  that the window injects into every request from its own session —
  another local process or user can't drive the agent.
- The page is sandboxed (`contextIsolation`, no Node, `sandbox: true`),
  every OS permission is refused except writing to the clipboard, and links
  in the agent's output open in the real browser, never in this window.
- One instance only: a second launch focuses the existing window.
- On quit, the server's whole process group is stopped (it spawns tool
  subprocesses, a browser, …) so nothing is orphaned; a server crash
  surfaces as a dialog showing its output, with Restart/Quit.

## Tests

```bash
npx vitest run packages/desktop
```

`navigation`, `settings`, `server-launch` and `server-supervisor` each have
real unit tests, and `npm run smoke:desktop` covers the end-to-end chain
against the real server.

## Building installers

```bash
npm run pack -w @finanfa/desktop   # an unpacked app under build/ (fast, no installer)
npm run dist -w @finanfa/desktop   # real installers, via electron-builder
```

Both first bundle the background server: one `server.mjs`, plus the
packages that can't be bundled — native code (sharp, serialport,
@napi-rs/canvas) and packages that read their own files (playwright-core,
web-tree-sitter and its grammars) — copied with their dependencies, the
ones npm installed for the current system. The ~400 MB local embedding
model is deliberately left out; the feature loads it on demand and reports
it missing instead of every install paying for it.

`installers.mjs` runs electron-builder with the exact installed Electron
version and never signs unless `CSC_LINK`/`CSC_NAME` is given — an unsigned
build must not pick up a random signing identity from the machine's
keychain — while an ad-hoc macOS signature keeps an unsigned bundle
launchable. Extra arguments pass through, e.g. `--mac --arm64` or `--dir`.
`.github/workflows/desktop-installers.yml` runs the same thing on each OS.
