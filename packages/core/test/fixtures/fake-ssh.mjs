#!/usr/bin/env node
// A real, standalone process standing in for the real `ssh` binary —
// this sandbox has no real SSH server to connect to, so run_remote_
// command's wrapper logic (argv shape, exit-code mapping, real stdout/
// stderr capture) is exercised against this instead, the same way
// fake-mydevops.mjs stands in for the real mydevops binary.
//
// ssh's real argv contract: everything after the target (host or
// user@host) is the remote command, so it's always the LAST argument
// here (this fixture doesn't need to parse -o/-p/-i flags, just find the
// tail).
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, renameSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const command = args[args.length - 1];

// Records the real argv this invocation received, one JSON line per
// call, WITHOUT touching stdout/stderr (which remote-deploy.ts's own
// callers parse, e.g. trimming readlink's stdout as the whole result) —
// lets remote-deploy.test.ts assert on the exact ssh argv shape
// (BatchMode/user@host/command placement) separately from exercising
// the real command execution below.
if (process.env.FAKE_SSH_ARGV_LOG_FILE) {
  appendFileSync(process.env.FAKE_SSH_ARGV_LOG_FILE, `${JSON.stringify(args)}\n`);
}

// Simulates N consecutive real ssh connection-level failures (exit 255)
// before succeeding — a state file (a real, separate process per
// invocation can't share in-memory state) tracks how many are left, so
// retry logic can be exercised against a host that's flaky for a bit and
// then recovers, without this fixture itself needing to be long-lived.
if (process.env.FAKE_SSH_FAIL_COUNT_FILE) {
  let remaining = 0;
  try {
    remaining = Number(readFileSync(process.env.FAKE_SSH_FAIL_COUNT_FILE, "utf-8"));
  } catch {
    remaining = 0;
  }
  if (remaining > 0) {
    writeFileSync(process.env.FAKE_SSH_FAIL_COUNT_FILE, String(remaining - 1));
    console.error("ssh: connect to host flaky-host port 22: Connection refused");
    process.exit(255);
  }
}

if (process.env.FAKE_SSH_FAIL === "1") {
  console.error("ssh: connect to host unreachable-host port 22: Operation timed out");
  process.exit(255);
}

if (command === "whoami") {
  console.log(`args=${JSON.stringify(args)}`);
  process.exit(0);
}

if (command === "fail") {
  console.error("Permission denied (publickey).");
  process.exit(255); // ssh's real exit code for an auth failure
}

if (command === "remote-fail") {
  console.error("some remote command output on stderr");
  process.exit(7); // the REMOTE command's own nonzero exit — ssh itself connected fine, never 255
}

// remote-deploy.ts's own real commands — recognized and executed via
// real Node fs calls (not handed to the local system shell) so this
// fixture behaves the same on every dev machine and CI runner: the
// atomic `ln -sfn ... && mv -Tf ...` symlink swap in particular uses a
// GNU-coreutils-only mv flag (`-T`, real and correct on the Linux hosts
// this tool actually targets — see remote-deploy.ts's swapCommand
// comment) that plain macOS/BSD `mv` doesn't understand, which would
// make this fixture fail on a Mac dev box for a reason that has nothing
// to do with remote-deploy.ts's own logic. fs.renameSync is the same
// underlying atomic rename(2) syscall real `mv` between two paths on one
// filesystem uses, so this is still a real (not simulated) atomic swap —
// just invoked directly instead of through a shell that varies by OS.
// `cd <dir> && <command>` (startCommand/healthCheckCommand) is the one
// case still hedge through a real shell: those are deliberately
// arbitrary, user-authored commands (see remote-deploy.ts's injection-
// safety comment), and the tests only ever give this fixture portable
// POSIX commands (`true`, `false`, `test -f ...`).
const mkdirMatch = /^mkdir -p (.+)$/.exec(command);
if (mkdirMatch) {
  mkdirSync(mkdirMatch[1], { recursive: true });
  process.exit(0);
}

const swapMatch = /^ln -sfn (\S+) (\S+) && mv -Tf \S+ (\S+)$/.exec(command);
if (swapMatch) {
  const [, releasePath, tmpSymlink, currentSymlink] = swapMatch;
  if (existsSync(tmpSymlink)) rmSync(tmpSymlink, { force: true });
  symlinkSync(releasePath, tmpSymlink);
  renameSync(tmpSymlink, currentSymlink); // real rename(2) — atomic, same as real `mv` between two paths on one filesystem
  process.exit(0);
}

const readlinkMatch = /^readlink (\S+) 2>\/dev\/null \|\| true$/.exec(command);
if (readlinkMatch) {
  try {
    console.log(readlinkSync(readlinkMatch[1]));
  } catch {
    // No such symlink yet (first-ever deploy) — real readlink would
    // print nothing and exit nonzero, masked by `|| true` in the real
    // command too.
  }
  process.exit(0);
}

const lsMatch = /^ls -1 (\S+) 2>\/dev\/null \|\| true$/.exec(command);
if (lsMatch) {
  try {
    for (const name of readdirSync(lsMatch[1]).sort()) console.log(name);
  } catch {
    // Directory doesn't exist yet — real `ls` would print nothing here too.
  }
  process.exit(0);
}

const rmMatch = /^rm -rf (.+)$/.exec(command);
if (rmMatch) {
  for (const target of rmMatch[1].split(" ")) rmSync(target, { recursive: true, force: true });
  process.exit(0);
}

if (command.startsWith("cd ")) {
  const result = spawnSync("/bin/sh", ["-c", command], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

console.log(`ran: ${command}`);
process.exit(0);
