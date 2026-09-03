import { spawn } from "node:child_process";

/** Best-effort cross-platform "open URL in the default browser". Never throws. */
export function openUrl(url: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // Best-effort — the URL is always printed to the console as a fallback.
  }
}
