#!/usr/bin/env node
// A real, standalone process standing in for the real `rsync` binary —
// same reasoning as fake-ssh.mjs/fake-argocd.mjs: no real second machine
// to rsync to in this sandbox. Reproduces the real argv shape
// remote-deploy.ts sends (`-az -e "<ssh> -o BatchMode=yes" <src>/
// <user>@<host>:<dest>/`) so the wrapper's argv construction is exercised
// for real, and actually copies files (recursively, real fs) from the
// local source into the destination path so the rest of the deploy flow
// (a health check that reads a file the deploy just shipped, remote_
// list_releases, pruning) sees a real, populated release directory
// afterwards — not just a recorded argv string.
import { cpSync, existsSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

if (process.env.FAKE_RSYNC_FAIL === "1") {
  console.error("rsync: connection unexpectedly closed (fake failure)");
  process.exit(23); // rsync's real "partial transfer" exit code
}

console.log(`real args received: ${JSON.stringify(args)}`);

const source = args[args.length - 2];
const destSpec = args[args.length - 1];
// destSpec looks like "user@host:/real/local/path/" in these tests —
// the "user@host:" prefix is fake (no real remote), so everything after
// the FIRST colon is treated as a real local path to copy into,
// mirroring how fake-ssh.mjs's other commands operate on a real local
// directory standing in for "the remote host".
const colonIndex = destSpec.indexOf(":");
const destPath = colonIndex === -1 ? destSpec : destSpec.slice(colonIndex + 1);

if (source && destPath) {
  mkdirSync(destPath, { recursive: true });
  if (existsSync(source)) cpSync(source, destPath, { recursive: true });
}

process.exit(0);
