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

const READY_LINE_RE = /listening on http:\/\/localhost:(\d+)/;

function waitForServerReady(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("web server did not start in time")), 15_000);
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const match = READY_LINE_RE.exec(buf);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
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
 * Spawns the real web server pointed at `projectDir`/`homeDir`, on a real,
 * OS-assigned free port (`PORT=0` — the OS never hands out one already in
 * use), with the real FINANFA_* / ANTHROPIC_API_KEY dev-shell env vars
 * cleared (see cli-prompt-mode.test.ts for why — this dev shell exports
 * them for manual testing against a real inference endpoint, which would
 * otherwise leak into these tests). Resolves with the real bound port once
 * the server is actually listening.
 *
 * Previously picked a "random" port in a caller-supplied range instead —
 * every e2e test file used its own range, but several overlapped (two
 * files could both land in 4980..5480), and vitest runs test files in
 * parallel workers, so two suites picking the same number was a real,
 * observed source of CI flakiness (a "bad port"/connection-refused
 * failure with no relation to the code under test). PORT=0 removes the
 * guesswork instead of just widening the ranges further.
 */
export async function spawnWebServer(projectDir: string, homeDir: string): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", FINANFA_WEB_CWD: projectDir, HOME: homeDir };
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
  const port = await waitForServerReady(child);
  return { child, port };
}

/** Kills the real server process AND the npx wrapper it was spawned through — see spawnWebServer's own comment on why a plain child.kill() alone isn't enough. */
export function killWebServer(child: ChildProcessWithoutNullStreams | undefined): void {
  if (child) killProcessGroup(child);
}
