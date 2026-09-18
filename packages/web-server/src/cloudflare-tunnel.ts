import { spawn, type ChildProcess } from "node:child_process";
import { killProcessGroup } from "@finanfa/core/src/util/process.js";

// Real, reported request: the user wants a public URL for this server
// without manually running `cloudflared tunnel --url ...` in a separate
// terminal every time (exactly what we did by hand earlier this session to
// test Telegram/Discord webhooks) — useful for any channel needing a real
// HTTPS webhook, and later for remotely controlling whatever apps get
// built on top of this server. Opt-in only (FINANFA_TUNNEL=1): a server
// exposing itself to the public internet just because it happened to
// start would be a real surprise, not a convenience.
const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const START_TIMEOUT_MS = 20_000;

export interface CloudflareTunnel {
  url: string;
  stop: () => void;
}

function isCloudflaredMissing(err: NodeJS.ErrnoException): boolean {
  return err.code === "ENOENT";
}

/**
 * Starts a real `cloudflared` "quick tunnel" pointed at the given local
 * port and resolves once it prints its assigned public URL. Returns
 * undefined (after logging a clear, actionable message) if `cloudflared`
 * isn't on PATH — deliberately not auto-installed, so a missing binary
 * fails loud and obvious rather than this project silently reaching out
 * to download and run a third-party binary on its own.
 */
export function startCloudflareTunnel(port: number): Promise<CloudflareTunnel | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`]);
    } catch (err) {
      console.error(`FINANFA_TUNNEL is set, but failed to start cloudflared: ${err instanceof Error ? err.message : String(err)}`);
      resolve(undefined);
      return;
    }

    let settled = false;
    let buf = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`FINANFA_TUNNEL is set, but cloudflared didn't report a tunnel URL within ${START_TIMEOUT_MS / 1000}s. Output so far:\n${buf}`);
      killProcessGroup(child);
      resolve(undefined);
    }, START_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      if (settled) return;
      buf += chunk.toString();
      const match = TRYCLOUDFLARE_URL_RE.exec(buf);
      if (!match) return;
      settled = true;
      clearTimeout(timeout);
      console.log(`Cloudflare quick tunnel ready: ${match[0]}`);
      resolve({ url: match[0], stop: () => killProcessGroup(child) });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (isCloudflaredMissing(err as NodeJS.ErrnoException)) {
        console.error(
          "FINANFA_TUNNEL is set, but the `cloudflared` binary isn't installed or isn't on PATH. " +
            "Install it (e.g. `brew install cloudflared` on macOS) and restart the server to get a public tunnel URL.",
        );
      } else {
        console.error(`FINANFA_TUNNEL is set, but cloudflared failed to start: ${err.message}`);
      }
      resolve(undefined);
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      console.error(`FINANFA_TUNNEL is set, but cloudflared exited early (code ${code}) before reporting a tunnel URL:\n${buf}`);
      resolve(undefined);
    });
  });
}
