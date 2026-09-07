#!/usr/bin/env node
// A real, standalone process standing in for arduino-cli/pio (platformio)
// — neither is installed in this project's dev sandbox (both need a
// system package install this sandbox has no interactive sudo for).
// Reproduces just enough of a real embedded-toolchain CLI's argv/cwd/
// exit-code contract for run_arduino_cli/run_platformio's wrapper logic
// to be tested for real.
const args = process.argv.slice(2);

if (args[0] === "upload" && args.includes("/dev/ttyDOESNOTEXIST99")) {
  console.error("Error: no device found on /dev/ttyDOESNOTEXIST99");
  process.exit(1);
}

console.log(`cwd=${process.cwd()}`);
console.log(`ran: ${args.join(" ")}`);
process.exit(0);
