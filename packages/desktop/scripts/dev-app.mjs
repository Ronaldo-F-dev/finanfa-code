import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// On macOS the name in the Dock, the menu bar and Cmd-Tab, and the icon, come from the app BUNDLE (its Info.plist
// and .icns) — not from anything the running app can set. `electron .` runs the stock Electron.app, so it always
// showed up as "Electron" with Electron's atom icon. This builds, once, a copy of that bundle named "Finanfa" with
// our icon (an APFS clone: instant, no extra disk) and runs the app from it. A packaged build gets the same for
// free from its builder; this only exists for `npm run dev:desktop`.

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICON = path.join(desktopDir, "assets", "icon.png");
const DEV_DIR = path.join(desktopDir, ".dev");
const APP = path.join(DEV_DIR, "Finanfa.app");
const STAMP = path.join(DEV_DIR, "stamp.json");

export const APP_NAME = "Finanfa";
export const BUNDLE_ID = "dev.finanfa.desktop";

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

/** Path of the stock Electron.app, downloading the binary first if it isn't there yet (requiring "electron" does that). */
function stockElectronApp() {
  require("electron");
  return path.join(path.dirname(require.resolve("electron/package.json")), "dist", "Electron.app");
}

function iconHash() {
  return createHash("sha256").update(readFileSync(ICON)).digest("hex");
}

/** An .icns built from the one 1024px PNG, at every size macOS asks for. */
function buildIcns(target) {
  const work = mkdtempSync(path.join(tmpdir(), "finanfa-iconset-"));
  const iconset = path.join(work, "Finanfa.iconset");
  mkdirSync(iconset);
  const sizes = [16, 32, 128, 256, 512];
  for (const size of sizes) {
    run("sips", ["-z", String(size), String(size), ICON, "--out", path.join(iconset, `icon_${size}x${size}.png`)]);
    run("sips", ["-z", String(size * 2), String(size * 2), ICON, "--out", path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  run("iconutil", ["-c", "icns", iconset, "-o", target]);
  rmSync(work, { recursive: true, force: true });
}

function setPlist(plist, key, value) {
  const buddy = "/usr/libexec/PlistBuddy";
  try {
    run(buddy, ["-c", `Set :${key} ${value}`, plist]);
  } catch {
    run(buddy, ["-c", `Add :${key} string ${value}`, plist]);
  }
}

/** Builds (or reuses) .dev/Finanfa.app and returns the path of its executable. */
export function ensureDevApp() {
  const source = stockElectronApp();
  const electronVersion = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf-8")).version;
  const stamp = JSON.stringify({ electronVersion, icon: iconHash() });
  const exe = path.join(APP, "Contents", "MacOS", "Electron");

  if (existsSync(exe) && existsSync(STAMP) && readFileSync(STAMP, "utf-8") === stamp) return exe;

  console.log(`Preparing the ${APP_NAME} app bundle (first run, or Electron/the icon changed)…`);
  rmSync(DEV_DIR, { recursive: true, force: true });
  mkdirSync(DEV_DIR, { recursive: true });
  try {
    run("cp", ["-cR", source, APP]); // clonefile: instant on APFS
  } catch {
    run("cp", ["-R", source, APP]);
  }

  const plist = path.join(APP, "Contents", "Info.plist");
  setPlist(plist, "CFBundleName", APP_NAME);
  setPlist(plist, "CFBundleDisplayName", APP_NAME);
  setPlist(plist, "CFBundleIdentifier", BUNDLE_ID);
  buildIcns(path.join(APP, "Contents", "Resources", "electron.icns"));
  // Editing the bundle invalidates its signature, and Apple Silicon refuses to run an unsigned/invalid one.
  run("codesign", ["--force", "--deep", "--sign", "-", APP]);

  writeFileSync(STAMP, stamp);
  return exe;
}
