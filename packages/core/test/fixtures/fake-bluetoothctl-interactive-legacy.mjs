#!/usr/bin/env node
// Variant of fake-bluetoothctl-interactive.mjs whose list-attributes output
// includes a known legacy/vendor UART-bridge service UUID (0000ffe0-...),
// used by bluetooth-scan.test.ts to exercise the GATT audit's legacy-service
// finding without complicating the shared fixture's fixed script.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
console.log("Agent registered");

rl.on("line", (line) => {
  const cmd = line.trim();
  if (cmd === "menu gatt") {
    console.log("Menu gatt:");
  } else if (cmd.startsWith("list-attributes")) {
    console.log("Primary Service (Handle 0x0001)");
    console.log("\t/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service0001");
    console.log("\t0000ffe0-0000-1000-8000-00805f9b34fb");
    console.log("\tVendor UART Bridge");
  } else if (cmd === "quit" || cmd === "exit") {
    rl.close();
    process.exit(0);
  } else {
    console.log(`Unknown command: ${cmd}`);
  }
});
