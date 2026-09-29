#!/usr/bin/env node
// Stands in for `bluetoothctl` run WITHOUT a subcommand (interactive REPL
// mode), used by packages/bluetooth/gatt for read-only GATT discovery:
// select-attribute / list-attributes / read all work by writing lines to
// stdin and reading the printed response back off stdout, same as the real
// tool's menu-driven interface.
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
    console.log("\t00001800-0000-1000-8000-00805f9b34fb");
    console.log("Characteristic (Handle 0x0003)");
    console.log("\t/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service0001/char0003");
    console.log("\t00002a00-0000-1000-8000-00805f9b34fb");
    console.log("\tDevice Name");
  } else if (cmd.startsWith("select-attribute")) {
    console.log(`[/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF] Attribute selected`);
  } else if (cmd === "read") {
    console.log("Attempting to read /org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service0001/char0003");
    console.log("\tValue: 57 69 72 65 6c 65 73 73 2d 4c 61 62");
  } else if (cmd === "notify on") {
    console.log("Notify started");
  } else if (cmd === "back" || cmd === "quit" || cmd === "exit") {
    if (cmd === "quit" || cmd === "exit") {
      rl.close();
      process.exit(0);
    }
    console.log("[bluetooth]#");
  } else {
    console.log(`Unknown command: ${cmd}`);
  }
});
