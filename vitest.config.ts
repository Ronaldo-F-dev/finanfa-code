import { defineConfig } from "vitest/config";

// packages/web-server/test's e2e suites each spawn a REAL subprocess server
// (`npx tsx src/index.ts`, index.ts has top-level app.listen side effects —
// see spawn-server.ts) — ~30 files do this. Under the default unlimited
// file concurrency, running the full suite (364 files) spawns many of these
// simultaneously, and CI's modest runner has repeatedly shown spurious
// "did not start in time" / timeout failures from the resulting CPU/fd
// contention — confirmed, more than once, by re-running the exact same
// failing file alone afterward and seeing it pass cleanly every time.
//
// Tried a reduced worker count first (after also fixing resume-provider.
// test.ts/resume-error-log.test.ts's too-tight timeout — see their own
// comments), but real runs still showed several failing files from genuine
// CPU contention between concurrently-spawned servers (effort-tiers.
// test.ts, switch-model-provider.test.ts and others timing out waiting for
// events that were just arriving late). `fileParallelism: false` (fully
// sequential — Vitest's own documented way to force this, NOT the
// deprecated-in-v4 `poolOptions.forks.maxForks`, which this version warns
// on and does not actually honor) is the only setting that was reliable
// across repeated real runs; it costs several real minutes of CI time, but
// that's the accepted tradeoff for "the suite tells the truth" over "the
// suite is fast but lies some of the time."
export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        test: {
          name: "web-server-e2e",
          environment: "node",
          include: ["packages/web-server/test/**/*.test.{ts,tsx}"],
          pool: "forks",
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "default",
          environment: "node",
          include: ["packages/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "packages/web-server/test/**"],
          // Many suites here spawn real subprocesses (fake ssh/rsync/iw/tmux binaries, git, ...).
          // With every file running concurrently, the 5s default is too tight on a loaded machine:
          // different, unrelated tests timed out on each full run and passed alone every time.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
