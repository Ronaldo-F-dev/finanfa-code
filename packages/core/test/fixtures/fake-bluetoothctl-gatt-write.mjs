#!/usr/bin/env node
// Stands in for `bluetoothctl` run WITHOUT a subcommand (interactive REPL),
// exercising the connect → menu gatt → select-attribute → write → read →
// disconnect flow that writeGattCharacteristic drives. Self-contained
// branching (no env plumbing): a device address containing "DEAD" fails to
// connect, a characteristic path containing "readonly" rejects the write,
// and a successful write is reflected straight back by the next `read`.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
console.log("Agent registered");

let selectedReadonly = false;
let lastWrittenBytes = null; // e.g. ["01","02"]

rl.on("line", (line) => {
  const cmd = line.trim();
  if (cmd.startsWith("connect ")) {
    const address = cmd.slice("connect ".length);
    console.log(`Attempting to connect to ${address}`);
    console.log(address.replace(/:/g, "").toUpperCase().includes("DEAD") ? "Failed to connect: org.bluez.Error.Failed" : "Connection successful");
  } else if (cmd === "menu gatt") {
    console.log("Menu gatt:");
  } else if (cmd.startsWith("select-attribute")) {
    selectedReadonly = cmd.includes("readonly");
    console.log("[bluetooth]# Attribute selected");
  } else if (cmd.startsWith("write ")) {
    if (selectedReadonly) {
      console.log("Attempting to write");
      console.log("org.bluez.Error.NotPermitted");
    } else {
      lastWrittenBytes = cmd
        .slice("write ".length)
        .trim()
        .split(/\s+/)
        .map((t) => t.replace(/^0x/i, "").padStart(2, "0"));
      console.log("Attempting to write /org/bluez/hci0/dev/char");
    }
  } else if (cmd === "read") {
    if (lastWrittenBytes && !selectedReadonly) {
      console.log("Attempting to read /org/bluez/hci0/dev/char");
      console.log(`\tValue: ${lastWrittenBytes.join(" ")}`);
    } else {
      console.log("Attempting to read");
    }
  } else if (cmd.startsWith("disconnect")) {
    console.log("Successful disconnected");
  } else if (cmd === "quit" || cmd === "exit") {
    rl.close();
    process.exit(0);
  } else {
    console.log(`[bluetooth]# `);
  }
});
