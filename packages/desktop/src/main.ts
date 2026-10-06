import { app, BrowserWindow, dialog, globalShortcut, Menu, session, shell, type MenuItemConstructorOptions } from "electron";
import { realpathSync, statSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { isInternalUrl, isSafeExternalUrl } from "./navigation.js";
import { buildServerSpawn, generateToken } from "./server-launch.js";
import { startServer, type RunningServer } from "./server-supervisor.js";
import { DEFAULT_BOUNDS, isUsableWorkspace, loadSettings, saveSettings, type DesktopSettings } from "./settings.js";

const SMOKE = process.argv.includes("--smoke");
const DOCS_URL = "https://github.com/Ronaldo-F-dev/finanfa-code#readme";
/** A dedicated session: the Authorization header is injected for this window only, never for anything else the app might load. */
const PARTITION = "persist:finanfa";

let settings: DesktopSettings = {};
let settingsFile = "";
let server: RunningServer | undefined;
let serverOrigin = "";
let mainWindow: BrowserWindow | undefined;
let quitting = false;

/** Leaves the app, stopping the server and everything it started first — app.exit() alone skips before-quit and would orphan it. */
async function exitApp(code: number): Promise<never> {
  quitting = true;
  globalShortcut.unregisterAll();
  await server?.stop().catch(() => {});
  return app.exit(code) as never;
}

/** Progress on stderr in smoke runs (and with FINANFA_DESKTOP_DEBUG=1), where nobody is looking at a window. */
function log(message: string): void {
  if (SMOKE || process.env.FINANFA_DESKTOP_DEBUG) console.error(`[desktop] ${message}`);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** --workspace=<dir>, else the last one used, else ask. Returns undefined if the user cancels. */
async function resolveWorkspace(): Promise<string | undefined> {
  const flag = process.argv.find((a) => a.startsWith("--workspace="))?.slice("--workspace=".length);
  if (flag && isDirectory(flag)) return path.resolve(flag);
  if (settings.workspace && isDirectory(settings.workspace) && isUsableWorkspace(realpathSync(settings.workspace), realpathSync(os.tmpdir()))) return settings.workspace;
  if (SMOKE) return app.getPath("temp");
  const picked = await dialog.showOpenDialog({
    title: "Choose the folder finanfa works in",
    message: "The agent reads, edits and runs commands in this folder. You can change it later from the File menu.",
    defaultPath: app.getPath("documents"),
    properties: ["openDirectory", "createDirectory"],
  });
  return picked.canceled ? undefined : picked.filePaths[0];
}

function splashHtml(text: string): string {
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1115;color:#c9ced8;font:15px system-ui,sans-serif"><div style="text-align:center"><div style="font-size:42px;margin-bottom:12px">₣</div>${text}</div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createWindow(): BrowserWindow {
  const b = settings.bounds ?? DEFAULT_BOUNDS;
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 480,
    minHeight: 360,
    show: !SMOKE,
    backgroundColor: "#0f1115",
    title: "finanfa",
    webPreferences: {
      partition: PARTITION,
      // The page is the web UI and nothing more: no Node, isolated, sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (b.maximized) win.maximize();

  const remember = () => {
    // A smoke run is a test: it must never write the real user's settings (it once stored the temp dir as their workspace).
    if (SMOKE || win.isDestroyed()) return;
    settings = { ...settings, bounds: { ...win.getNormalBounds(), maximized: win.isMaximized() } };
    void saveSettings(settingsFile, settings);
  };
  win.on("resized", remember);
  win.on("moved", remember);
  win.on("maximize", remember);
  win.on("unmaximize", remember);

  // The window shows ONE origin. A link in an agent's reply can point anywhere; it opens in the real browser, never here.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const guard = (event: { preventDefault: () => void }, url: string) => {
    if (!serverOrigin || isInternalUrl(url, serverOrigin) || url.startsWith("data:text/html")) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  };
  win.webContents.on("will-navigate", guard);
  win.webContents.on("will-redirect", guard);
  return win;
}

/** The web UI sends plain requests with no auth of its own; every request this window makes to ITS server carries the per-launch token instead. */
function injectToken(port: number, token: string): void {
  const ses = session.fromPartition(PARTITION);
  ses.webRequest.onBeforeSendHeaders({ urls: [`http://127.0.0.1:${port}/*`, `ws://127.0.0.1:${port}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` } });
  });
  // Nothing the page asks the OS for is granted (camera, microphone, location, notifications...), except copying to the clipboard.
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "clipboard-sanitized-write"));
}

function buildMenu(): void {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    {
      label: "File",
      submenu: [
        { label: "Change workspace…", accelerator: "CmdOrCtrl+Shift+O", click: () => void changeWorkspace() },
        { label: "Server log…", click: () => showServerLog() },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "forceReload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }, ...(app.isPackaged ? [] : [{ type: "separator" } as MenuItemConstructorOptions, { role: "toggleDevTools" } as MenuItemConstructorOptions])],
    },
    { role: "windowMenu" },
    { label: "Help", submenu: [{ label: "Documentation", click: () => void shell.openExternal(DOCS_URL) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function changeWorkspace(): Promise<void> {
  const picked = await dialog.showOpenDialog(mainWindow ?? ({} as BrowserWindow), {
    title: "Choose the folder finanfa works in",
    defaultPath: settings.workspace,
    properties: ["openDirectory", "createDirectory"],
  });
  if (picked.canceled || !picked.filePaths[0]) return;
  settings = { ...settings, workspace: picked.filePaths[0] };
  await saveSettings(settingsFile, settings);
  // The server's working folder is fixed at start, so the app restarts into the new one.
  app.relaunch();
  app.quit();
}

function showServerLog(): void {
  void dialog.showMessageBox({ type: "info", title: "Server log", message: "Recent server output", detail: (server?.output() ?? "(server not running)").slice(-3000), buttons: ["Close"] });
}

async function onServerCrash(code: number | null): Promise<void> {
  if (quitting) return;
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: "finanfa stopped",
    message: `The finanfa server stopped unexpectedly (exit code ${code ?? "unknown"}).`,
    detail: (server?.output() ?? "").slice(-1500),
    buttons: ["Restart", "Quit"],
    defaultId: 0,
  });
  if (response === 0) app.relaunch();
  app.quit();
}

/** SMOKE: prove the whole chain without showing anything — window loads, the token reaches REST and WebSocket, and an unauthenticated caller is refused. */
async function runSmoke(win: BrowserWindow, port: number): Promise<void> {
  const results: Record<string, unknown> = {};
  const unauthenticated = await new Promise<number>((resolve) => {
    http.get({ host: "127.0.0.1", port, path: "/api/models" }, (res) => resolve(res.statusCode ?? 0)).on("error", () => resolve(0));
  });
  results.unauthenticatedStatus = unauthenticated;
  results.page = await win.webContents.executeJavaScript(`({ title: document.title, hasRoot: Boolean(document.getElementById("root")), rootChildren: document.getElementById("root")?.children.length ?? 0 })`);
  results.authenticatedApi = await win.webContents.executeJavaScript(`fetch("/api/projects").then((r) => r.status)`);
  results.webSocket = await win.webContents.executeJavaScript(
    `new Promise((resolve) => { const w = new WebSocket("ws://" + location.host + "/ws?model=smoke"); const t = setTimeout(() => resolve("timeout"), 8000); w.onopen = () => { clearTimeout(t); w.close(); resolve("open"); }; w.onclose = (e) => { if (e.code === 4001) { clearTimeout(t); resolve("rejected"); } }; w.onerror = () => {}; })`,
  );
  const ok = results.unauthenticatedStatus === 401 && results.authenticatedApi === 200 && results.webSocket === "open" && (results.page as { hasRoot: boolean }).hasRoot;
  console.log(`SMOKE ${ok ? "OK" : "FAILED"} ${JSON.stringify(results)}`);
  await exitApp(ok ? 0 : 1);
}

async function start(): Promise<void> {
  app.setName("Finanfa");
  // An explicit --user-data-dir (tests, portable installs) wins over the default location.
  if (!process.argv.some((a) => a.startsWith("--user-data-dir="))) app.setPath("userData", path.join(app.getPath("appData"), "finanfa-desktop"));
  settingsFile = path.join(app.getPath("userData"), "settings.json");
  settings = await loadSettings(settingsFile);

  const workspace = await resolveWorkspace();
  log(`workspace: ${workspace}`);
  if (!workspace) return app.quit();
  if (!SMOKE && workspace !== settings.workspace) {
    settings = { ...settings, workspace };
    await saveSettings(settingsFile, settings);
  }

  buildMenu();
  mainWindow = createWindow();
  void mainWindow.loadURL(splashHtml("Starting finanfa…"));

  const token = generateToken();
  const spec = buildServerSpawn({
    packaged: app.isPackaged,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
    workspace,
    token,
    parentPid: process.pid,
    baseEnv: process.env,
  });

  log(`starting server: ${spec.command} ${spec.args.join(" ")}`);
  try {
    server = await startServer(spec, workspace);
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(-2500) : String(err);
    if (SMOKE) {
      // No human to click a dialog in a smoke run: report and fail.
      console.error(`SMOKE FAILED: the server did not start: ${detail}`);
      return exitApp(1);
    }
    await dialog.showMessageBox({ type: "error", title: "finanfa could not start", message: "The local server did not start.", detail });
    return app.quit();
  }
  void server.crashed.then(onServerCrash);

  serverOrigin = `http://127.0.0.1:${server.port}`;
  log(`server ready at ${serverOrigin}`);
  injectToken(server.port, token);
  await mainWindow.loadURL(serverOrigin);
  log("page loaded");
  if (SMOKE) return runSmoke(mainWindow, server.port);

  // A global shortcut to bring finanfa forward (or hide it) from anywhere — it fails quietly if another app owns the combination.
  globalShortcut.register("CommandOrControl+Shift+Space", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => mainWindow?.show());
  // Quit only after the server (and everything it started) is stopped.
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    globalShortcut.unregisterAll();
    if (!server) return;
    event.preventDefault();
    void server.stop().finally(() => app.exit(0));
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
  void app.whenReady().then(start).catch((err) => {
    console.error(err);
    void exitApp(1);
  });
}

