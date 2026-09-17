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
const args = process.argv.slice(2);
const command = args[args.length - 1];

if (command === "whoami") {
  console.log(`args=${JSON.stringify(args)}`);
  process.exit(0);
}

if (command === "fail") {
  console.error("Permission denied (publickey).");
  process.exit(255); // ssh's real exit code for an auth failure
}

console.log(`ran: ${command}`);
process.exit(0);
