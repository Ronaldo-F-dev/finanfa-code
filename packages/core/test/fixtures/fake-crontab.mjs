#!/usr/bin/env node
// A real, standalone process reproducing crontab(1)'s exact CLI contract
// (`-l` to list, no args + stdin to replace) that scheduler.ts's tests
// point scheduler.ts at instead of the real system crontab — the real
// crontab must never be touched by an automated test suite (it's actual
// system state, not something a test run should modify). Storage is a
// plain file at FAKE_CRONTAB_FILE, set by the test.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const file = process.env.FAKE_CRONTAB_FILE;
if (!file) {
  console.error("FAKE_CRONTAB_FILE not set");
  process.exit(1);
}

const args = process.argv.slice(2);

if (args[0] === "-l") {
  if (!existsSync(file)) {
    console.error("no crontab for fake-user");
    process.exit(1);
  }
  process.stdout.write(readFileSync(file, "utf-8"));
  process.exit(0);
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  writeFileSync(file, input, "utf-8");
  process.exit(0);
});
