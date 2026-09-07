#!/usr/bin/env node
// A real, standalone process standing in for the real avrdude binary,
// which needs root/apt install this project's dev sandbox doesn't have
// interactive sudo for (see firmware-flash.ts's test file for details).
// Reproduces avrdude's real argv/exit-code shape closely enough to test
// run_avrdude's wrapper logic for real.
const args = process.argv.slice(2);

if (args.includes("-P") && args[args.indexOf("-P") + 1] === "/dev/ttyDOESNOTEXIST99") {
  console.error("avrdude: ser_open(): can't open device \"/dev/ttyDOESNOTEXIST99\": No such file or directory");
  process.exit(1);
}

console.log(`avrdude: real args received: ${JSON.stringify(args)}`);
process.exit(0);
