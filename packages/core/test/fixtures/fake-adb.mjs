#!/usr/bin/env node
// A real, standalone process standing in for the real `adb` binary — see
// usb-devices.test.ts for why (adb is genuinely not installed in this
// sandbox). Reproduces adb's real argv/output shape closely enough to
// test list_usb_devices' and run_adb_command's wrapper logic for real.
const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

if (args[0] === "devices" && args[1] === "-l") {
  console.log("List of devices attached");
  console.log("R58N90ABCDE            device usb:1-1 product:raven model:Pixel_7_Pro device:raven transport_id:3");
  console.log("emulator-5554          offline transport_id:1");
  process.exit(0);
}

if (args[0] === "-s") {
  const serial = args[1];
  const rest = args.slice(2);
  if (rest[0] === "shell" && rest[1] === "fail") {
    console.error("real adb error: something went wrong on device");
    process.exit(1);
  }
  console.log(`real args received for ${serial}: ${JSON.stringify(rest)}`);
  process.exit(0);
}

console.error(`fake-adb: unrecognized args ${JSON.stringify(args)}`);
process.exit(1);
