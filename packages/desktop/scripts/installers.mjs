import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs electron-builder with the exact Electron version installed here (it refuses a range such as "^44.5.1").
// Extra arguments go through: `--dir` for an unpacked app, `--mac` / `--win` / `--linux`, `--x64` / `--arm64`.
const require = createRequire(import.meta.url);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronVersion = require("electron/package.json").version;
const bin = path.join(path.dirname(require.resolve("electron-builder/package.json")), "cli.js");

// Without a certificate given explicitly (CSC_LINK or CSC_NAME, which the release workflow sets from its secrets),
// do not sign. Left alone, electron-builder picks up whatever signing identity it finds in the machine's keychain,
// which for a build on someone's own computer means signing with their personal developer account.
const signingGiven = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
const env = signingGiven ? process.env : { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
// An unsigned app on Apple silicon is refused as "damaged"; an ad hoc signature ("-", no certificate involved) keeps the bundle consistent.
const adHoc = signingGiven ? [] : ["--config.mac.identity=-", "--config.mac.hardenedRuntime=false"];

const result = spawnSync(process.execPath, [bin, `--config.electronVersion=${electronVersion}`, "--publish", "never", ...adHoc, ...process.argv.slice(2)], {
  cwd: desktopDir,
  stdio: "inherit",
  env,
});
process.exit(result.status ?? 1);
