# finanfa-code mobile & desktop app

The native Flutter client for finanfa-code — a chat UI (sessions,
connectors, settings) that talks to a running finanfa-code **web
server** over HTTP/WebSocket, instead of embedding the agent itself.
Same agent, same tools/config as the terminal UI or browser web client;
this app is just another frontend for it.

Ships to iOS, Android, macOS, Windows, and Linux from the one Flutter
codebase.

## Point it at a server

Start a finanfa-code web server first (see the root
[README.md](../README.md#browser) / [docs/deployment.md](../docs/deployment.md)):

```bash
npm run dev:web-server   # http://localhost:4600 by default
```

Then, in the app's connect screen, enter that server's base URL (e.g.
`http://localhost:4600`, or a deployed server's `https://...` URL) and
connect. If the server requires auth (`FINANFA_WEB_USERS`/
`FINANFA_WEB_ACCOUNTS`/OIDC — see
[docs/deployment.md](../docs/deployment.md#multi-user-access-gateway)),
the connect screen will prompt for credentials after it reaches the
server.

## Run it locally

```bash
cd apps
flutter pub get
flutter run              # picks a connected device/simulator, or pass -d <device>
```

Requires a working Flutter install (`flutter doctor`) for whichever
target platform you're building for.

## Windows / Linux builds

Desktop builds for Windows (zipped release build) and Linux (a real
`.deb`) are produced by CI, not built locally by default — see
[.github/workflows/desktop-build.yml](../.github/workflows/desktop-build.yml),
triggered manually (`workflow_dispatch`) or by pushing a `v*` tag.
Artifacts are attached to that workflow run.
