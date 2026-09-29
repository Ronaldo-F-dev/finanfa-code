#!/usr/bin/env node
// A real, standalone process standing in for Linux's `bluetoothctl` — see
// bluetooth-scan.test.ts. `scan on` just idles until killed (matching real
// bluetoothctl's interactive-scan behavior); `devices` prints a fixed
// known-device list.
const args = process.argv.slice(2);

if (args.length === 0) {
  process.exit(0);
}

if (args[0] === "scan" && args[1] === "on") {
  // Idle forever; the caller SIGTERMs this after its scan window.
  setInterval(() => {}, 1_000_000);
} else if (args[0] === "devices") {
  console.log("Device 11:22:33:44:55:66 AirPods Pro");
  console.log("Device AA:BB:CC:DD:EE:FF Old Keyboard");
  process.exit(0);
} else {
  console.error(`fake-bluetoothctl: unrecognized args ${JSON.stringify(args)}`);
  process.exit(1);
}
