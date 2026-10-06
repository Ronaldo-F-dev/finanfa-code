import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `npm run dev:desktop` / `npm run smoke`: runs the app with Electron. On macOS through a bundle named "Finanfa" with
// our icon (see dev-app.mjs), elsewhere through the stock binary.

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let executable;
if (process.platform === "darwin") {
  const { ensureDevApp } = await import("./dev-app.mjs");
  executable = ensureDevApp();
} else {
  executable = require("electron");
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // would turn Electron into plain Node
const child = spawn(executable, [desktopDir, ...process.argv.slice(2)], { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
