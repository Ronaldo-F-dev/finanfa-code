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
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const command = args[args.length - 1];

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

console.log(`ran: ${command}`);
process.exit(0);
