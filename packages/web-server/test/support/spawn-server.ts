import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killProcessGroup } from "@finanfa/core/src/util/process.js";

// Shared by every web-server e2e test that needs the real server running
// as a real subprocess (index.ts has top-level side effects — app.listen
// at import time — so it can't be exercised in-process the way cli.ts's
// main() can). Extracted after the same spawn/wait logic was copy-pasted
// (and started drifting) across trust-and-hooks.test.ts and
// docker-models-api.test.ts.
export const webServerDir = path.dirname(fileURLToPath(import.meta.url)).replace(/\/test\/support$/, "");

function waitForServerReady(child: ChildProcessWithoutNullStreams, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("web server did not start in time")), 15_000);
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(`listening on http://localhost:${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (d: Buffer) => (buf += d.toString()));
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`web server exited early (code ${code}): ${buf}`));
    });
  });
}

/**
 * Spawns the real web server pointed at `projectDir`/`homeDir`, on a
 * randomly chosen port in `portRangeStart..+500`, with the real
 * FINANFA_* / ANTHROPIC_API_KEY dev-shell env vars cleared (see
 * cli-prompt-mode.test.ts for why — this dev shell exports them for
 * manual testing against a real inference endpoint, which would
 * otherwise leak into these tests). Resolves once it's actually
 * listening.
 */
export async function spawnWebServer(
  projectDir: string,
  homeDir: string,
  portRangeStart: number,
): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  const port = portRangeStart + Math.floor(Math.random() * 500);
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), FINANFA_WEB_CWD: projectDir, HOME: homeDir };
  for (const k of ["FINANFA_PROVIDER", "FINANFA_BASE_URL", "FINANFA_MODEL", "FINANFA_API_KEY", "FINANFA_API_KEYS", "ANTHROPIC_API_KEY"]) delete env[k];

  // detached: true (+ killWebServer's process-group kill below) — real bug
  // found running this suite repeatedly: `npx tsx src/index.ts` spawns tsx
  // as a grandchild of the `npx` process this actually returns, so
  // `child.kill()` alone only killed the outer npx wrapper — the real
  // server (and its bound port) survived as an orphan. Every test run
  // leaked another one, and they eventually collided on a reused port
  // number, failing later runs with EADDRINUSE for a reason that had
  // nothing to do with the code under test. Same shape of bug as
  // background-process.ts's own real orphan-process fix.
  const child = spawn("npx", ["tsx", "src/index.ts"], { cwd: webServerDir, env, detached: true }) as ChildProcessWithoutNullStreams;
  await waitForServerReady(child, port);
  return { child, port };
}

/** Kills the real server process AND the npx wrapper it was spawned through — see spawnWebServer's own comment on why a plain child.kill() alone isn't enough. */
export function killWebServer(child: ChildProcessWithoutNullStreams | undefined): void {
  if (child) killProcessGroup(child);
}
