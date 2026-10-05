import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

/** Mutable accumulator kept alive past server startup — lets a caller assert on log lines (e.g. the no-gateway-auth startup warning) that may arrive in the same or a later chunk than the "listening on" line, without re-attaching a stream listener after the fact and racing already-delivered chunks. */
export interface ServerOutput {
  text: string;
}

function waitForServerReady(child: ChildProcessWithoutNullStreams, output: ServerOutput): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("web server did not start in time")), 15_000);
    child.stdout.on("data", (d: Buffer) => {
      output.text += d.toString();
      const match = READY_LINE_RE.exec(output.text);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (d: Buffer) => (output.text += d.toString()));
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`web server exited early (code ${code}): ${output.text}`));
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
export async function spawnWebServer(
  projectDir: string,
  homeDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ child: ChildProcessWithoutNullStreams; port: number; output: ServerOutput }> {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", FINANFA_WEB_CWD: projectDir, HOME: homeDir };
  // Real, reported bug found chasing spurious channel-image-attachment
  // failures: FINANFA_VISION_* wasn't in this list, so a dev shell's real
  // vision-provider config (e.g. a real NVIDIA/OpenAI-compatible vision
  // endpoint set up for manual testing) leaked into every test here too —
  // selectVisionProvider(config) picked it up and routed any test sending
  // an image to a REAL external vision endpoint instead of this test's
  // local fake LLM server, so the request never showed up in whatever the
  // test was tracking, and the response (from a real model, using real
  // credentials) got treated as a normal successful turn.
  for (const k of [
    "FINANFA_PROVIDER",
    "FINANFA_BASE_URL",
    "FINANFA_MODEL",
    "FINANFA_API_KEY",
    "FINANFA_API_KEYS",
    "ANTHROPIC_API_KEY",
    "FINANFA_VISION_PROVIDER",
    "FINANFA_VISION_BASE_URL",
    "FINANFA_VISION_API_KEY",
    "FINANFA_VISION_MODEL",
  ])
    delete env[k];
  // Deliberately NOT clearing FINANFA_WEB_USERS/FINANFA_WEB_ACCOUNTS here —
  // gateway-auth.test.ts/gateway-accounts.test.ts already set/delete those
  // directly on process.env themselves (before this function reads it via
  // the spread above) as their own established pattern. extraEnv is purely
  // additive on top, for a caller that wants to set something without
  // touching process.env globally.
  Object.assign(env, extraEnv);

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
  const output: ServerOutput = { text: "" };
  const port = await waitForServerReady(child, output);
  return { child, port, output };
}

/** Kills the real server process AND the npx wrapper it was spawned through — see spawnWebServer's own comment on why a plain child.kill() alone isn't enough. */
export function killWebServer(child: ChildProcessWithoutNullStreams | undefined): void {
  if (child) killProcessGroup(child);
}

/**
 * Creates the pair of temp dirs spawnWebServer needs (a project dir with a
 * `.finanfa-code/config.json`, and a separate `$HOME`) — extracted after
 * the same three-line mkdtemp/mkdir/writeFile sequence (with only the temp
 * prefix and config body differing) kept getting copy-pasted into each new
 * e2e test file's beforeAll, which is exactly the kind of near-duplicate
 * block SonarCloud's "Duplication on New Code" gate flags.
 */
const DEFAULT_TEST_CONFIG: Record<string, unknown> = { provider: "anthropic", apiKey: "unused-in-this-test" };

export async function createTempProject(prefix: string, config: Record<string, unknown> = DEFAULT_TEST_CONFIG): Promise<{ projectDir: string; homeDir: string }> {
  const projectDir = await mkdtemp(path.join(tmpdir(), `finanfa-web-${prefix}-project-`));
  const homeDir = await mkdtemp(path.join(tmpdir(), `finanfa-web-${prefix}-home-`));
  await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
  await writeFile(path.join(projectDir, ".finanfa-code", "config.json"), JSON.stringify(config));
  return { projectDir, homeDir };
}
